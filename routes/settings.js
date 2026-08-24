/**
 * 系统设置 & 通知路由
 */
const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();
const { queryAll, queryOne, run, saveDB, getDB } = require('../db');
const config = require('../config');
const { descendantIds } = require('../services/organization');
const { isGlobalManagerRole, isSupervisorUser } = require('../services/roles');
const { canAccessTicket } = require('./tickets');
const { getStaffReport, completionExpression } = require('../services/reporting');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  getActiveRule,
  listRuleVersions,
  createRuleVersion,
} = require('../services/performance');
const {
  publicTenantAlertConfig,
  saveTenantAlertConfig,
  sendWaitingTicketsAlert,
} = require('../services/jzm-messaging');

const REPORT_BUSINESS_ERRORS = new Set([
  'PROFILE_NOT_FOUND',
  'REPORT_SCOPE_FORBIDDEN',
  'INVALID_DATE_RANGE',
  'INVALID_STAFF_ID',
  'INVALID_PERFORMANCE_RULE',
]);

function reportError(res, error) {
  if (REPORT_BUSINESS_ERRORS.has(error.code)) {
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

function hasColumn(table, column) {
  return queryAll(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

// ============ 句子秒懂 Token ============
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getJzmAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) return cachedAccessToken;
  if (!config.JZMM_ACCESS_KEY_ID || !config.JZMM_ACCESS_KEY_SECRET) throw new Error('未配置秒懂密钥');
  const resp = await fetch(`${config.JZMM_BASE_URL}/openapi/get-access-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessKeyId: config.JZMM_ACCESS_KEY_ID, accessKeySecret: config.JZMM_ACCESS_KEY_SECRET })
  });
  const result = await resp.json();
  if (result.code !== 0 || !result.data) throw new Error('获取 token 失败');
  cachedAccessToken = result.data.accessToken;
  tokenExpiresAt = Date.now() + result.data.expiresIn * 1000;
  return cachedAccessToken;
}

async function triggerJzmWorkflowEvent(sessionId, message, options = {}) {
  const token = await getJzmAccessToken();
  const body = { botId: options.botId || config.JZMM_BOT_ID, eventId: options.eventId || config.JZMM_EVENT_ID, sessionId, params: { message }, isMh: true };
  const resp = await fetch(`${config.JZMM_BASE_URL}/openapi/workflow/event/trigger`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await resp.json().catch(() => ({}));
  return (resp.status === 201 || (result && result.code === 0)) ? { success: true, data: result } : { success: false, error: result };
}

// ============ 定时提醒 ============
const reminderTimers = new Map();
const slaTimers = new Map();

function getIntervalSetting(tenantId, key) {
  const row = queryOne(`SELECT value FROM tenant_settings
    WHERE tenant_id = ? AND key = ?`, [tenantId, key]);
  const value = Number(row?.value || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function setIntervalSetting(tenantId, key, intervalMinutes) {
  const value = Math.max(0, Number(intervalMinutes) || 0);
  const now = new Date().toISOString();
  run(`INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  [tenantId, key, String(value), now, now]);
  return value;
}

function getWaitingTicketCount(tenantId) {
  const row = queryOne(`SELECT COUNT(*) AS count FROM tickets
    WHERE tenant_id = ? AND status = 'wait'`, [tenantId]);
  return Number(row?.count || 0);
}

function startReminders(tenantId) {
  const existing = reminderTimers.get(tenantId);
  if (existing) clearInterval(existing);
  reminderTimers.delete(tenantId);
  const reminderInterval = getIntervalSetting(tenantId, 'reminder_interval_minutes') * 60000;
  if (reminderInterval <= 0) return;
  const timer = setInterval(async () => {
    const count = getWaitingTicketCount(tenantId);
    if (count > 0) await sendWaitingTicketsAlert({ db: getDB(), tenantId, count }).catch(() => {});
  }, reminderInterval);
  reminderTimers.set(tenantId, timer);
}

function checkSlaOverdue(tenantId) {
  const now = Date.now();
  const active = queryAll(`SELECT * FROM tickets
    WHERE tenant_id = ? AND status IN ('wait','doing','confirm','pending')`, [tenantId]);
  return active.filter(row => {
    const hours = (now - new Date(row.created).getTime()) / 3600000;
    const threshold = config.SLA_THRESHOLDS[row.priority] || 24;
    return hours > threshold;
  }).map(row => ({ id: row.id, cat: row.cat, loc: row.loc, worker: row.worker, priority: row.priority, hoursOverdue: +((Date.now() - new Date(row.created).getTime()) / 3600000 - (config.SLA_THRESHOLDS[row.priority] || 24)).toFixed(1) }));
}

function startSlaAlerts(tenantId) {
  const existing = slaTimers.get(tenantId);
  if (existing) clearInterval(existing);
  slaTimers.delete(tenantId);
  const slaInterval = getIntervalSetting(tenantId, 'sla_interval_minutes') * 60000;
  if (slaInterval <= 0) return;
  const timer = setInterval(async () => {
    const overdue = checkSlaOverdue(tenantId);
    if (overdue.length) {
      const msg = `⚠️ SLA超时：${overdue.length}张工单超时\n` + overdue.map(t => `• ${t.id}｜${t.cat}｜超${t.hoursOverdue}h`).join('\n');
      await triggerJzmWorkflowEvent(config.JZMM_ALERT_SESSION_ID, msg).catch(() => {});
    }
  }, slaInterval);
  slaTimers.set(tenantId, timer);
}

// ============ 路由 ============

router.use(requireAuth, (req, res, next) => {
  if (rejectClientTenant(req, res)) return;
  next();
});

// GET/POST /api/settings/jzm-alert
router.get('/settings/jzm-alert', requireAdmin, (req, res) => {
  res.json({ data: publicTenantAlertConfig(getDB(), req.user.tenant_id) });
});

router.post('/settings/jzm-alert', requireAdmin, async (req, res) => {
  try {
    const data = saveTenantAlertConfig(getDB(), req.user.tenant_id, req.body || {});
    await saveDB();
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || '保存秒回预警配置失败',
      code: error.code || 'JZM_ALERT_CONFIG_ERROR',
    });
  }
});

// POST /api/notify
router.post('/notify', requireAuth, async (req, res) => {
  const { ticketId, event } = req.body;
  const row = queryOne('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!row) return res.status(404).json({ error: '工单不存在' });
  if (Object.prototype.hasOwnProperty.call(row, 'tenant_id')
      && String(row.tenant_id || '') !== String(req.user.tenant_id || '')) {
    return res.status(403).json({ error: '无权操作该工单', code: 'TICKET_SCOPE_FORBIDDEN' });
  }
  if (!canAccessTicket(req, ticketId)) return res.status(403).json({ error: '无权操作该工单', code: 'TICKET_SCOPE_FORBIDDEN' });
  if (!config.NOTIFY_WEBHOOK) return res.json({ success: false, error: '未配置 NOTIFY_WEBHOOK' });
  try {
    const resp = await fetch(config.NOTIFY_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: event || 'completed', ticket: row, timestamp: new Date().toISOString() }) });
    res.json({ success: resp.ok });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/reminder/trigger
router.get('/reminder/trigger', requireAuth, requireAdmin, async (req, res) => {
  const count = getWaitingTicketCount(req.user.tenant_id);
  if (!count) return res.json({ success: true, message: '当前无待派单', count: 0 });
  const result = await sendWaitingTicketsAlert({ db: getDB(), tenantId: req.user.tenant_id, count });
  res.json({ success: true, sent: Boolean(result.success), message: result.success ? '已推送' : '工单存在，但秒回预警未发送', count });
});

// GET/POST /api/settings/reminder
router.get('/settings/reminder', requireAuth, requireAdmin, (req, res) => {
  res.json({ intervalMinutes: getIntervalSetting(req.user.tenant_id, 'reminder_interval_minutes') });
});
router.post('/settings/reminder', requireAuth, requireAdmin, async (req, res) => {
  try {
    const intervalMinutes = setIntervalSetting(
      req.user.tenant_id, 'reminder_interval_minutes', req.body.intervalMinutes
    );
    await saveDB();
    startReminders(req.user.tenant_id);
    res.json({ success: true, intervalMinutes, message: intervalMinutes > 0 ? `每${intervalMinutes}分钟推送` : '已关闭' });
  } catch (error) {
    reportError(res, error);
  }
});

// GET/POST /api/settings/sla
router.get('/settings/sla', requireAuth, requireAdmin, (req, res) => {
  res.json({ intervalMinutes: getIntervalSetting(req.user.tenant_id, 'sla_interval_minutes') });
});
router.post('/settings/sla', requireAuth, requireAdmin, async (req, res) => {
  try {
    const intervalMinutes = setIntervalSetting(
      req.user.tenant_id, 'sla_interval_minutes', req.body.intervalMinutes
    );
    await saveDB();
    startSlaAlerts(req.user.tenant_id);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    reportError(res, error);
  }
});

// GET/POST /api/settings/performance
// 规则是版本化的：历史版本只读，发布新规则后仅后续工单使用新版本。
router.get('/settings/performance', requireAuth, (req, res) => {
  try {
    res.json({
      data: {
        active: getActiveRule(getDB(), req.user.tenant_id),
        // 登录用户可读取当前规则；历史版本属于管理数据，仅主管可见。
        versions: req.user && isSupervisorUser(req.user)
          ? listRuleVersions(getDB(), req.user.tenant_id) : [],
      },
    });
  } catch (error) {
    return reportError(res, error);
  }
});

router.post('/settings/performance/versions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const active = createRuleVersion(
      getDB(), req.body || {}, req.user.id, req.user.tenant_id
    );
    // 发布成功必须等待持久化，避免进程重启后规则版本回滚。
    await saveDB();
    return res.status(201).json({
      data: { active, versions: listRuleVersions(getDB(), req.user.tenant_id) },
    });
  } catch (error) {
    return reportError(res, error);
  }
});

// GET /api/sla/overdue
router.get('/sla/overdue', requireAuth, requireAdmin, (req, res) => {
  res.json({ data: checkSlaOverdue(req.user.tenant_id) });
});
router.get('/sla/alert', requireAuth, requireAdmin, async (req, res) => {
  const overdue = checkSlaOverdue(req.user.tenant_id);
  if (!overdue.length) return res.json({ success: true, message: '无超时' });
  const msg = `⚠️ SLA超时：${overdue.length}张\n` + overdue.map(t => `• ${t.id}｜${t.cat}｜超${t.hoursOverdue}h`).join('\n');
  await triggerJzmWorkflowEvent(config.JZMM_ALERT_SESSION_ID, msg).catch(() => {});
  res.json({ success: true, count: overdue.length });
});

// GET /api/report
router.get('/report', requireAuth, (req, res) => {
  if (req.query.staff_id !== undefined && req.query.staff_id !== '') {
    try {
      if (!req.user) {
        return res.status(401).json({
          error: '未登录或 token 已过期',
          code: 'AUTH_REQUIRED',
        });
      }
      const profiles = queryAll(`SELECT id, user_id, manager_id FROM staff_profiles
        WHERE tenant_id = ?`, [req.user.tenant_id]);
      const own = profiles.find((profile) => Number(profile.user_id) === Number(req.user.id));
      if (!own) return res.status(404).json({ error: '人员档案不存在', code: 'PROFILE_NOT_FOUND' });
      const target = Number(req.query.staff_id);
      const allowed = isSupervisorUser(req.user) || target === Number(own.id);
      if (!allowed) {
        return res.status(403).json({ error: '无权查看该人员', code: 'REPORT_SCOPE_FORBIDDEN' });
      }
      const data = getStaffReport(require('../db').getDB(), target, {
        tenantId: req.user.tenant_id,
        from: req.query.from,
        to: req.query.to,
        communityId: req.query.community_id,
      });
      return res.json({ success: true, data });
    } catch (error) {
      return reportError(res, error);
    }
  }
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const to = req.query.to || new Date().toISOString();
  const communityId = req.query.community_id;
  if (!isSupervisorUser(req.user)) {
    return res.status(403).json({ error: '请使用人员报告接口查看本人数据', code: 'REPORT_SCOPE_FORBIDDEN' });
  }
  const completion = completionExpression(getDB());
  const ticketTenantAware = hasColumn('tickets', 'tenant_id');
  const tenantSql = ticketTenantAware ? 'tenant_id = ? AND ' : '';
  const tenantParams = ticketTenantAware ? [req.user.tenant_id] : [];
  let all = communityId
    ? queryAll(`SELECT t.*, ${completion} report_finished FROM tickets t
        WHERE ${tenantSql}community_id = ?`, [...tenantParams, communityId])
    : queryAll(`SELECT t.*, ${completion} report_finished FROM tickets t
        ${ticketTenantAware ? 'WHERE tenant_id = ?' : ''}`, tenantParams);
  const fromDate = new Date(from), toDate = new Date(to);
  const inRange = all.filter(r => new Date(r.created) >= fromDate && new Date(r.created) <= toDate);
  const done = inRange.filter(r => r.status === 'done' && r.report_finished);
  const durations = done.map(r => (new Date(r.report_finished) - new Date(r.created)) / 3600000).filter(h => h > 0);
  const avgHours = durations.length ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1) : 0;
  const report = `工单报告 ${from.slice(0,10)} ~ ${to.slice(0,10)}\n总计 ${inRange.length} 张，已完成 ${done.length}，平均 ${avgHours}h`;
  res.json({ success: true, from: from.slice(0,10), to: to.slice(0,10), report, stats: { total: inRange.length, done: done.length, avgHours } });
});

// POST /api/jzm/trigger-event
router.post('/jzm/trigger-event', requireAuth, requireAdmin, async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: '缺少参数' });
  try { const result = await triggerJzmWorkflowEvent(sessionId, message); res.json(result); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
module.exports.triggerJzmWorkflowEvent = triggerJzmWorkflowEvent;
