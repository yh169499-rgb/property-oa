const express = require('express');
const rateLimit = require('express-rate-limit');
const database = require('../db');
const defaultConfig = require('../config');
const { requireAuth } = require('../middleware/auth');
const { descendantIds } = require('../services/organization');
const { getStaffReport, getAllStaffReport } = require('../services/reporting');
const { isManagerRole, isGlobalManagerRole, isSupervisorUser } = require('../services/roles');
const aiReportService = require('../services/ai-report');

const SAFE_CODES = new Set([
  'PROFILE_NOT_FOUND',
  'REPORT_SCOPE_FORBIDDEN',
  'INVALID_DATE_RANGE',
  'INVALID_STAFF_ID',
  'AI_REPORT_NOT_CONFIGURED',
  'AI_REPORT_QUOTA_EXHAUSTED',
  'AI_REPORT_RATE_LIMITED',
  'AI_REPORT_TIMEOUT',
  'AI_REPORT_INVALID_RESPONSE',
  'AI_REPORT_PROVIDER_ERROR',
]);

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function tableExists(db, table) {
  return rows(db, "SELECT 1 present FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length > 0;
}

function hasColumn(db, table, column) {
  return tableExists(db, table)
    && rows(db, `PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function scopedTarget(db, user, requestedId) {
  const tenantId = String(user.tenant_id || '');
  const profiles = rows(db, `SELECT id, user_id, name, manager_id FROM staff_profiles
    WHERE tenant_id = ?`, [tenantId]);
  const own = profiles.find((profile) => Number(profile.user_id) === Number(user.id));
  const targetId = Number(requestedId);
  const target = profiles.find((profile) => Number(profile.id) === targetId);
  if (!own || !target) {
    const error = new Error('人员档案不存在');
    error.status = 404;
    error.code = 'PROFILE_NOT_FOUND';
    throw error;
  }
  const allowed = isSupervisorUser(user)
    || Number(own.id) === targetId
    || (isManagerRole(user.role)
      && descendantIds(profiles, own.id).map(Number).includes(targetId));
  if (!allowed) {
    const error = new Error('无权分析该人员报告');
    error.status = 403;
    error.code = 'REPORT_SCOPE_FORBIDDEN';
    throw error;
  }
  return target;
}

function assertCommunityScope(db, user, target, communityId) {
  if (!communityId) return;
  if (tableExists(db, 'communities')) {
    const exists = rows(db, `SELECT 1 present FROM communities
      WHERE id = ?${hasColumn(db, 'communities', 'tenant_id') ? ' AND tenant_id = ?' : ''}`,
    [communityId, ...(hasColumn(db, 'communities', 'tenant_id') ? [user.tenant_id] : [])]).length > 0;
    if (!exists) {
      const error = new Error('无权分析该小区报告');
      error.status = 403;
      error.code = 'REPORT_SCOPE_FORBIDDEN';
      throw error;
    }
  }
  if (isSupervisorUser(user)) return;
  const member = tableExists(db, 'community_memberships') && rows(db, `
    SELECT 1 present FROM community_memberships
     WHERE tenant_id = ? AND community_id = ? AND staff_profile_id = ? LIMIT 1`,
  [user.tenant_id, communityId, Number(target.id)]).length > 0;
  const historicalTicket = tableExists(db, 'tickets') && rows(db, `
    SELECT 1 present FROM tickets
     WHERE community_id = ?
       ${hasColumn(db, 'tickets', 'tenant_id') ? 'AND tenant_id = ?' : ''}
       AND (assignee_user_id = ? OR (NULLIF(worker, '') IS NOT NULL AND worker = ?))
     LIMIT 1`, [communityId,
    ...(hasColumn(db, 'tickets', 'tenant_id') ? [user.tenant_id] : []),
    Number(target.user_id), target.name]).length > 0;
  if (!member && !historicalTicket) {
    const error = new Error('无权分析该小区报告');
    error.status = 403;
    error.code = 'REPORT_SCOPE_FORBIDDEN';
    throw error;
  }
}

function fail(res, error) {
  if (SAFE_CODES.has(error && error.code)) {
    return res.status(error.status || 400).json({
      error: error.message || '请求失败',
      code: error.code,
    });
  }
  return res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
}

function rejectClientTenant(req, res) {
  const source = { ...(req.query || {}), ...(req.body || {}) };
  if (!Object.hasOwn(source, 'tenant_id') && !Object.hasOwn(source, 'tenantId')) return false;
  res.status(400).json({
    error: '企业身份由服务端确定', code: 'CLIENT_TENANT_FORBIDDEN',
  });
  return true;
}

function createAiReportRouter(options = {}) {
  const config = options.config || defaultConfig;
  const analyzeReport = options.analyzeReport || aiReportService.analyzeReport;
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
    handler: (_req, res) => res.status(429).json({
      error: 'AI 报告请求过于频繁，请稍后再试',
      code: 'AI_REPORT_RATE_LIMITED',
    }),
  });

  router.use(requireAuth, (req, res, next) => {
    if (rejectClientTenant(req, res)) return;
    next();
  });

  router.get('/reports/ai/status', requireAuth, (_req, res) => {
    res.json({ data: {
      enabled: aiReportService.configured(config),
      model: config.AI_MODEL || 'qwen3.6-flash',
    } });
  });

  router.post('/reports/staff/all/ai-analysis', requireAuth, limiter, async (req, res) => {
    try {
      if (!isSupervisorUser(req.user)) {
        const error = new Error('无权分析全部人员报告');
        error.status = 403;
        error.code = 'REPORT_SCOPE_FORBIDDEN';
        throw error;
      }
      if (!aiReportService.configured(config)) {
        const error = new Error('AI 报告尚未配置，原始报告仍可正常使用');
        error.status = 503;
        error.code = 'AI_REPORT_NOT_CONFIGURED';
        throw error;
      }
      const { from, to } = req.body || {};
      if (!from || !to) {
        const error = new Error('开始日期和结束日期必须同时提供');
        error.status = 400;
        error.code = 'INVALID_DATE_RANGE';
        throw error;
      }
      const db = database.getDB();
      const profiles = rows(db, `
        SELECT id FROM staff_profiles
         WHERE tenant_id = ? AND COALESCE(employment_status, 'active') <> 'inactive'
         ORDER BY id
      `, [req.user.tenant_id]);
      const communityId = String(req.body.community_id || req.body.communityId || '');
      const filters = { from, to, communityId, tenantId: req.user.tenant_id };
      const report = getAllStaffReport(db, filters, profiles.map((profile) => profile.id));
      const result = await analyzeReport({
        db,
        report,
        filters: { ...filters, community_id: communityId },
        staffProfileId: null,
        actorUserId: req.user.id,
        tenantId: req.user.tenant_id,
        config,
        persist: database.saveDB,
      });
      res.json({ data: result });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/reports/staff/:staff_id/ai-analysis', requireAuth, limiter, async (req, res) => {
    try {
      if (!aiReportService.configured(config)) {
        const error = new Error('AI 报告尚未配置，原始报告仍可正常使用');
        error.status = 503;
        error.code = 'AI_REPORT_NOT_CONFIGURED';
        throw error;
      }
      const { from, to } = req.body || {};
      if (!from || !to) {
        const error = new Error('开始日期和结束日期必须同时提供');
        error.status = 400;
        error.code = 'INVALID_DATE_RANGE';
        throw error;
      }
      const db = database.getDB();
      const target = scopedTarget(db, req.user, req.params.staff_id);
      const communityId = String(req.body.community_id || req.body.communityId || '');
      assertCommunityScope(db, req.user, target, communityId);
      const filters = { from, to, communityId, tenantId: req.user.tenant_id };
      const report = getStaffReport(db, target.id, filters);
      const result = await analyzeReport({
        db,
        report,
        filters: { ...filters, community_id: communityId },
        staffProfileId: target.id,
        actorUserId: req.user.id,
        tenantId: req.user.tenant_id,
        config,
        persist: database.saveDB,
      });
      res.json({ data: result });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}

module.exports = { createAiReportRouter, scopedTarget, assertCommunityScope };
