const express = require('express');
const database = require('../db');
const { requireAuth } = require('../middleware/auth');
const { descendantIds } = require('../services/organization');
const { buildDayCalendar } = require('../services/calendar');
const {
  getDashboardStats,
  getStaffReport,
  getAllStaffReport,
  getManagerReport,
} = require('../services/reporting');
const { isManagerRole, isGlobalManagerRole, isSupervisorUser, positionForRole } = require('../services/roles');

const router = express.Router();
const BUSINESS_ERROR_CODES = new Set([
  'INVALID_CALENDAR_REQUEST',
  'INVALID_DATE',
  'PROFILE_NOT_FOUND',
  'CALENDAR_SCOPE_FORBIDDEN',
  'REPORT_SCOPE_FORBIDDEN',
  'INVALID_DATE_RANGE',
  'INVALID_STAFF_ID',
  'INVALID_REPORT_PERIOD',
]);

function all(sql, params = []) {
  const statement = database.getDB().prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function fail(res, error) {
  if (BUSINESS_ERROR_CODES.has(error.code)) {
    return res.status(error.status || 400).json({
      error: error.message || '请求失败',
      code: error.code,
    });
  }
  return res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
}

function ownProfile(profiles, userId) {
  return profiles.find((profile) => Number(profile.user_id) === Number(userId));
}

function ensureOwnProfile(user) {
  let profiles = all('SELECT * FROM staff_profiles WHERE tenant_id = ?', [user.tenant_id]);
  let own = ownProfile(profiles, user.id);
  if (own) return own;
  const now = new Date().toISOString();
  database.run(`INSERT OR IGNORE INTO staff_profiles
    (tenant_id, user_id, name, phone, position, employment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  [user.tenant_id, user.id, user.name || '', user.phone || '', positionForRole(user.role), now, now]);
  database.saveDB();
  profiles = all('SELECT * FROM staff_profiles WHERE tenant_id = ?', [user.tenant_id]);
  own = ownProfile(profiles, user.id);
  return own;
}

function assertStaffScope(req, requestedId, options = {}) {
  let profiles = all(`SELECT id, user_id, manager_id FROM staff_profiles
    WHERE tenant_id = ?`, [req.user.tenant_id]);
  let own = ownProfile(profiles, req.user.id);
  if (!own) {
    own = ensureOwnProfile(req.user);
    profiles = all(`SELECT id, user_id, manager_id FROM staff_profiles
      WHERE tenant_id = ?`, [req.user.tenant_id]);
  }
  if (!own) {
    const error = new Error('人员档案不存在');
    error.status = 404;
    error.code = 'PROFILE_NOT_FOUND';
    throw error;
  }
  const target = Number(requestedId);
  const allowed = isSupervisorUser(req.user)
    || target === Number(own.id)
    || (isManagerRole(req.user.role)
      && descendantIds(profiles, own.id).map(Number).includes(target));
  if (!allowed || (options.managerOnly && !isManagerRole(req.user.role))) {
    const error = new Error('无权查看该人员或团队');
    error.status = 403;
    error.code = 'REPORT_SCOPE_FORBIDDEN';
    throw error;
  }
  return { own, profiles };
}

function tableExists(name) {
  return all(
    "SELECT 1 present FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name]
  ).length > 0;
}

function communityQuery(req) {
  return req.query.community_id || req.query.communityId;
}

router.use(requireAuth, (req, res, next) => {
  const source = { ...(req.query || {}), ...(req.body || {}) };
  if (Object.hasOwn(source, 'tenant_id') || Object.hasOwn(source, 'tenantId')) {
    return res.status(400).json({
      error: '企业身份由服务端确定', code: 'CLIENT_TENANT_FORBIDDEN',
    });
  }
  next();
});

function dashboardScope(req, communityId) {
  let profiles = all(`SELECT id, user_id, name, manager_id FROM staff_profiles
    WHERE tenant_id = ?`, [req.user.tenant_id]);
  let own = ownProfile(profiles, req.user.id);
  if (!own) {
    own = ensureOwnProfile(req.user);
    profiles = all(`SELECT id, user_id, name, manager_id FROM staff_profiles
      WHERE tenant_id = ?`, [req.user.tenant_id]);
  }
  if (!own) {
    const error = new Error('人员档案不存在');
    error.status = 404;
    error.code = 'PROFILE_NOT_FOUND';
    throw error;
  }
  const staffIds = [Number(own.id), ...descendantIds(profiles, own.id).map(Number)];
  if (communityId && !isGlobalManagerRole(req.user.role)) {
    const placeholders = staffIds.map(() => '?').join(',');
    const hasTeamTicket = all(
      `SELECT 1
         FROM tickets
        WHERE community_id = ?
          AND tenant_id = ?
          AND assignee_user_id IN (
            SELECT user_id FROM staff_profiles
             WHERE tenant_id = ? AND id IN (${placeholders})
          )
        LIMIT 1`,
      [communityId, req.user.tenant_id, req.user.tenant_id, ...staffIds]
    ).length > 0;
    const hasPermission = tableExists('community_permissions') && all(
      `SELECT 1
         FROM community_permissions cp
         JOIN staff_profiles sp ON sp.name = cp.staff_name
        WHERE cp.tenant_id = ? AND sp.tenant_id = cp.tenant_id
          AND cp.community_id = ? AND sp.id IN (${placeholders})
        LIMIT 1`,
      [req.user.tenant_id, communityId, ...staffIds]
    ).length > 0;
    if (!hasTeamTicket && !hasPermission) {
      const error = new Error('无权查看该小区统计');
      error.status = 403;
      error.code = 'REPORT_SCOPE_FORBIDDEN';
      throw error;
    }
  }
  return staffIds;
}

router.get('/calendar/day', requireAuth, (req, res) => {
  try {
    let profiles = all(`SELECT id, user_id, manager_id FROM staff_profiles
      WHERE tenant_id = ?`, [req.user.tenant_id]);
    let own = profiles.find((profile) => Number(profile.user_id) === Number(req.user.id));
    if (!own) {
      own = ensureOwnProfile(req.user);
      profiles = all(`SELECT id, user_id, manager_id FROM staff_profiles
        WHERE tenant_id = ?`, [req.user.tenant_id]);
    }
    let staffId = req.query.staff_id;
    let managerId = req.query.manager_id;

    if (!isManagerRole(req.user.role)) {
      if (!own) {
        const error = new Error('人员档案不存在');
        error.status = 404;
        error.code = 'PROFILE_NOT_FOUND';
        throw error;
      }
      staffId = own.id;
      managerId = undefined;
    } else if (isManagerRole(req.user.role) && !isGlobalManagerRole(req.user.role)) {
      if (!own) {
        const error = new Error('人员档案不存在');
        error.status = 404;
        error.code = 'PROFILE_NOT_FOUND';
        throw error;
      }
      const scope = new Set([Number(own.id), ...descendantIds(profiles, own.id).map(Number)]);
      const requested = staffId ?? managerId;
      if (requested !== undefined && requested !== '' && !scope.has(Number(requested))) {
        const error = new Error('无权查看该人员或团队');
        error.status = 403;
        error.code = 'CALENDAR_SCOPE_FORBIDDEN';
        throw error;
      }
      if (staffId === undefined && managerId === undefined) managerId = own.id;
    }

    res.json(buildDayCalendar(database.getDB(), {
      date: req.query.date,
      staffId,
      managerId,
      communityId: communityQuery(req),
      viewerUserId: req.user.id,
      tenantId: req.user.tenant_id,
    }));
  } catch (error) {
    fail(res, error);
  }
});

router.get('/dashboard/stats', requireAuth, (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) {
      const error = new Error('需要主管权限');
      error.status = 403;
      error.code = 'REPORT_SCOPE_FORBIDDEN';
      throw error;
    }
    const staffIds = dashboardScope(req, communityQuery(req));
    res.json({ data: getDashboardStats(database.getDB(), {
      communityId: communityQuery(req),
      range: req.query.range,
      staffIds,
      tenantId: req.user.tenant_id,
    }) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/reports/staff/all', requireAuth, (req, res) => {
  try {
    if (!isGlobalManagerRole(req.user.role)) {
      const error = new Error('无权查看全部人员报告');
      error.status = 403;
      error.code = 'REPORT_SCOPE_FORBIDDEN';
      throw error;
    }
    // 主管的团队历史报告包含已离职人员，确保其历史工单与绩效仍可追溯。
    const profiles = all(`SELECT id FROM staff_profiles
      WHERE tenant_id = ? ORDER BY id`, [req.user.tenant_id]);
    res.json({ data: getAllStaffReport(database.getDB(), {
      tenantId: req.user.tenant_id,
      from: req.query.from,
      to: req.query.to,
      communityId: communityQuery(req),
    }, profiles.map((profile) => profile.id)) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/reports/staff/:staff_id', requireAuth, (req, res) => {
  try {
    assertStaffScope(req, req.params.staff_id);
    res.json({ data: getStaffReport(database.getDB(), req.params.staff_id, {
      tenantId: req.user.tenant_id,
      from: req.query.from,
      to: req.query.to,
      communityId: communityQuery(req),
    }) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/reports/manager/:staff_id', requireAuth, (req, res) => {
  try {
    assertStaffScope(req, req.params.staff_id, { managerOnly: true });
    res.json({ data: getManagerReport(database.getDB(), req.params.staff_id, {
      tenantId: req.user.tenant_id,
      from: req.query.from,
      to: req.query.to,
      communityId: req.query.community_id,
    }) });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/me/stats', requireAuth, (req, res) => {
  try {
    const profiles = all(`SELECT id, user_id FROM staff_profiles
      WHERE tenant_id = ?`, [req.user.tenant_id]);
    const own = ownProfile(profiles, req.user.id) || ensureOwnProfile(req.user);
    if (!own) {
      const error = new Error('人员档案不存在');
      error.status = 404;
      error.code = 'PROFILE_NOT_FOUND';
      throw error;
    }
    let filters = { tenantId: req.user.tenant_id, communityId: communityQuery(req) };
    if (req.query.period === 'day') {
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      filters = { ...filters, from: today, to: today };
    } else if (req.query.period === 'year') {
      const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear();
      filters = { ...filters, from: `${year}-01-01`, to: `${year}-12-31` };
    } else if (req.query.period && req.query.period !== 'month') {
      const error = new Error('period 只支持 day、month 或 year');
      error.status = 400;
      error.code = 'INVALID_REPORT_PERIOD';
      throw error;
    }
    res.json({ data: getStaffReport(database.getDB(), own.id, filters) });
  } catch (error) {
    fail(res, error);
  }
});

module.exports = router;
