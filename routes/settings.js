/**
 * 系统设置 & 通知路由
 */
const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();
const { queryAll, queryOne, run, saveDB, getDB } = require('../db');
const config = require('../config');
const { descendantIds } = require('../services/organization');
const { getStaffReport, completionExpression } = require('../services/reporting');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  getActiveRule,
  listRuleVersions,
  createRuleVersion,
} = require('../services/performance');

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
let reminderInterval = 0, reminderTimer = null;
let slaInterval = 0, slaTimer = null;

function getWaitingTicketsReminder() {
  const waitTickets = queryAll("SELECT * FROM tickets WHERE status = 'wait'");
  return waitTickets.length ? `当前还有 ${waitTickets.length} 张工单待派单，请尽快处理。` : null;
}

function startReminders() {
  if (reminderTimer) clearInterval(reminderTimer);
  if (reminderInterval <= 0) return;
  reminderTimer = setInterval(async () => {
    const reminder = getWaitingTicketsReminder();
    if (reminder) await triggerJzmWorkflowEvent(config.JZMM_ALERT_SESSION_ID, reminder).catch(() => {});
  }, reminderInterval);
}

function checkSlaOverdue() {
  const now = Date.now();
  const active = queryAll("SELECT * FROM tickets WHERE status IN ('wait','doing','confirm','pending')");
  return active.filter(row => {
    const hours = (now - new Date(row.created).getTime()) / 3600000;
    const threshold = config.SLA_THRESHOLDS[row.priority] || 24;
    return hours > threshold;
  }).map(row => ({ id: row.id, cat: row.cat, loc: row.loc, worker: row.worker, priority: row.priority, hoursOverdue: +((Date.now() - new Date(row.created).getTime()) / 3600000 - (config.SLA_THRESHOLDS[row.priority] || 24)).toFixed(1) }));
}

function startSlaAlerts() {
  if (slaTimer) clearInterval(slaTimer);
  if (slaInterval <= 0) return;
  slaTimer = setInterval(async () => {
    const overdue = checkSlaOverdue();
    if (overdue.length) {
      const msg = `⚠️ SLA超时：${overdue.length}张工单超时\n` + overdue.map(t => `• ${t.id}｜${t.cat}｜超${t.hoursOverdue}h`).join('\n');
      await triggerJzmWorkflowEvent(config.JZMM_ALERT_SESSION_ID, msg).catch(() => {});
    }
  }, slaInterval);
}

// ============ 路由 ============

// POST /api/notify
router.post('/notify', async (req, res) => {
  const { ticketId, event } = req.body;
  const row = queryOne('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!row) return res.status(404).json({ error: '工单不存在' });
  if (!config.NOTIFY_WEBHOOK) return res.json({ success: false, error: '未配置 NOTIFY_WEBHOOK' });
  try {
    const resp = await fetch(config.NOTIFY_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: event || 'completed', ticket: row, timestamp: new Date().toISOString() }) });
    res.json({ success: resp.ok });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /api/reminder/trigger
router.get('/reminder/trigger', async (req, res) => {
  const reminder = getWaitingTicketsReminder();
  if (reminder) {
    await triggerJzmWorkflowEvent(config.JZMM_ALERT_SESSION_ID, reminder).catch(() => {});
    res.json({ success: true, message: '已推送' });
  } else { res.json({ success: true, message: '当前无待派单' }); }
});

// GET/POST /api/settings/reminder
router.get('/settings/reminder', (req, res) => { res.json({ intervalMinutes: reminderInterval / 60000 }); });
router.post('/settings/reminder', (req, res) => {
  const { intervalMinutes } = req.body;
  reminderInterval = Math.max(0, Number(intervalMinutes) || 0) * 60000;
  startReminders();
  res.json({ success: true, intervalMinutes: reminderInterval / 60000, message: reminderInterval > 0 ? `每${reminderInterval/60000}分钟推送` : '已关闭' });
});

// GET/POST /api/settings/sla
router.get('/settings/sla', (req, res) => { res.json({ intervalMinutes: slaInterval / 60000 }); });
router.post('/settings/sla', (req, res) => {
  const { intervalMinutes } = req.body;
  slaInterval = Math.max(0, Number(intervalMinutes) || 0) * 60000;
  startSlaAlerts();
  res.json({ success: true, intervalMinutes: slaInterval / 60000 });
});

// GET/POST /api/settings/performance
// 规则是版本化的：历史版本只读，发布新规则后仅后续工单使用新版本。
router.get('/settings/performance', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json({
      data: {
        active: getActiveRule(getDB()),
        versions: listRuleVersions(getDB()),
      },
    });
  } catch (error) {
    return reportError(res, error);
  }
});

router.post('/settings/performance/versions', requireAuth, requireAdmin, (req, res) => {
  try {
    const active = createRuleVersion(getDB(), req.body || {}, req.user.id);
    // saveDB is intentionally best-effort here; persistence middleware handles retry.
    Promise.resolve(saveDB()).catch(() => {});
    return res.status(201).json({
      data: { active, versions: listRuleVersions(getDB()) },
    });
  } catch (error) {
    return reportError(res, error);
  }
});

// GET /api/sla/overdue
router.get('/sla/overdue', (req, res) => { res.json({ data: checkSlaOverdue() }); });
router.get('/sla/alert', async (req, res) => {
  const overdue = checkSlaOverdue();
  if (!overdue.length) return res.json({ success: true, message: '无超时' });
  const msg = `⚠️ SLA超时：${overdue.length}张\n` + overdue.map(t => `• ${t.id}｜${t.cat}｜超${t.hoursOverdue}h`).join('\n');
  await triggerJzmWorkflowEvent(config.JZMM_ALERT_SESSION_ID, msg).catch(() => {});
  res.json({ success: true, count: overdue.length });
});

// GET /api/report
router.get('/report', (req, res) => {
  if (req.query.staff_id !== undefined && req.query.staff_id !== '') {
    try {
      if (!req.user) {
        return res.status(401).json({
          error: '未登录或 token 已过期',
          code: 'AUTH_REQUIRED',
        });
      }
      const profiles = queryAll('SELECT id, user_id, manager_id FROM staff_profiles');
      const own = profiles.find((profile) => Number(profile.user_id) === Number(req.user.id));
      if (!own) return res.status(404).json({ error: '人员档案不存在', code: 'PROFILE_NOT_FOUND' });
      const target = Number(req.query.staff_id);
      const allowed = req.user.role === 'admin'
        || target === Number(own.id)
        || (req.user.role === 'lead'
          && descendantIds(profiles, own.id).map(Number).includes(target));
      if (!allowed) {
        return res.status(403).json({ error: '无权查看该人员', code: 'REPORT_SCOPE_FORBIDDEN' });
      }
      const data = getStaffReport(require('../db').getDB(), target, {
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
  const completion = completionExpression(getDB());
  let all = communityId
    ? queryAll(`SELECT t.*, ${completion} report_finished FROM tickets t WHERE community_id = ?`, [communityId])
    : queryAll(`SELECT t.*, ${completion} report_finished FROM tickets t`);
  const fromDate = new Date(from), toDate = new Date(to);
  const inRange = all.filter(r => new Date(r.created) >= fromDate && new Date(r.created) <= toDate);
  const done = inRange.filter(r => r.status === 'done' && r.report_finished);
  const durations = done.map(r => (new Date(r.report_finished) - new Date(r.created)) / 3600000).filter(h => h > 0);
  const avgHours = durations.length ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1) : 0;
  const report = `工单报告 ${from.slice(0,10)} ~ ${to.slice(0,10)}\n总计 ${inRange.length} 张，已完成 ${done.length}，平均 ${avgHours}h`;
  res.json({ success: true, from: from.slice(0,10), to: to.slice(0,10), report, stats: { total: inRange.length, done: done.length, avgHours } });
});

// POST /api/jzm/trigger-event
router.post('/jzm/trigger-event', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: '缺少参数' });
  try { const result = await triggerJzmWorkflowEvent(sessionId, message); res.json(result); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
module.exports.triggerJzmWorkflowEvent = triggerJzmWorkflowEvent;
