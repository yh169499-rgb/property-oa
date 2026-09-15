const { sendTicketAlert } = require('./jzm-messaging');

const reminderTimers = new Map();
const REMINDER_STATUSES = ['wait', 'pending', 'confirm'];
const ACTIVE_STATUSES = new Set(REMINDER_STATUSES);
const REMINDER_SETTING_KEY = 'ticket_reminder_intervals_v2';
const LEGACY_REMINDER_SETTING_KEY = 'reminder_interval_minutes';
const STATUS_ACTIONS = new Set([
  'assign', 'accept', 'return', 'submit', 'suspend', 'resume', 'reject', 'approve_complete',
]);

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function normalizeInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(1440, Math.max(1, Math.round(number)));
}

function validateInterval(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1440) {
    const error = new Error('提醒时长必须是 0—1440 的整数分钟');
    error.status = 400;
    error.code = 'INVALID_REMINDER_INTERVALS';
    throw error;
  }
  return number;
}

function validateIntervals(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('提醒时长配置格式无效');
    error.status = 400;
    error.code = 'INVALID_REMINDER_INTERVALS';
    throw error;
  }
  return Object.fromEntries(REMINDER_STATUSES.map((status) => {
    if (!Object.prototype.hasOwnProperty.call(input, status)) {
      const error = new Error(`缺少 ${status} 状态提醒时长`);
      error.status = 400;
      error.code = 'INVALID_REMINDER_INTERVALS';
      throw error;
    }
    return [status, validateInterval(input[status])];
  }));
}

function getReminderInterval(db, tenantId) {
  const row = one(db, `SELECT value FROM tenant_settings
    WHERE tenant_id = ? AND key = '${LEGACY_REMINDER_SETTING_KEY}'`, [tenantId]);
  return normalizeInterval(row?.value);
}

function getReminderIntervals(db, tenantId) {
  const row = one(db, `SELECT value FROM tenant_settings
    WHERE tenant_id = ? AND key = ?`, [tenantId, REMINDER_SETTING_KEY]);
  if (row) {
    try {
      return validateIntervals(JSON.parse(row.value));
    } catch (_) {
      // 损坏的新配置不应阻止租户登录；回退到旧配置或关闭提醒。
    }
  }
  const legacy = getReminderInterval(db, tenantId);
  return Object.fromEntries(REMINDER_STATUSES.map((status) => [status, legacy]));
}

function setReminderInterval(db, tenantId, value, now = new Date().toISOString()) {
  const intervalMinutes = normalizeInterval(value);
  db.run(`INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  [tenantId, 'reminder_interval_minutes', String(intervalMinutes), now, now]);
  return intervalMinutes;
}

function setReminderIntervals(db, tenantId, intervals, now = new Date().toISOString()) {
  const value = validateIntervals(intervals);
  db.run(`INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  [tenantId, REMINDER_SETTING_KEY, JSON.stringify(value), now, now]);
  return value;
}

function resetTicketReminderState(db, tenantId, ticketId) {
  db.run('DELETE FROM ticket_reminder_state WHERE tenant_id = ? AND ticket_id = ?', [tenantId, ticketId]);
}

function reminderKind(ticket) {
  return ticket.status === 'doing' ? 'overdue_worker' : 'overdue_manager';
}

function statusStartedAt(db, ticket) {
  const activities = rows(db, `SELECT action, created_at FROM ticket_activity_logs
    WHERE tenant_id = ? AND ticket_id = ? ORDER BY created_at DESC, id DESC`,
  [ticket.tenant_id, ticket.id]);
  const statusActivity = activities.find((row) => STATUS_ACTIONS.has(row.action));
  if (statusActivity?.created_at) return statusActivity.created_at;
  if (ticket.status === 'doing' && ticket.assigned_at) return ticket.assigned_at;
  return ticket.created;
}

function isDueAt(nowMs, baseValue, intervalMinutes) {
  const baseMs = Date.parse(baseValue || '');
  return Number.isFinite(baseMs) && nowMs - baseMs >= intervalMinutes * 60000;
}

async function runDueReminders({
  db,
  tenantId,
  now = new Date(),
  send = sendTicketAlert,
}) {
  const intervals = getReminderIntervals(db, tenantId);
  if (!Object.values(intervals).some((value) => value > 0)) return { checked: 0, sent: 0 };
  const tickets = rows(db, `SELECT * FROM tickets
    WHERE tenant_id = ? AND status IN ('wait','pending','confirm')`, [tenantId]);
  const nowMs = now.getTime();
  let sent = 0;
  for (const ticket of tickets) {
    if (!ACTIVE_STATUSES.has(ticket.status)) continue;
    const intervalMinutes = intervals[ticket.status];
    if (!intervalMinutes) continue;
    const state = one(db, `SELECT last_sent_at FROM ticket_reminder_state
      WHERE tenant_id = ? AND ticket_id = ? AND status = ?`,
    [tenantId, ticket.id, ticket.status]);
    const base = state?.last_sent_at || statusStartedAt(db, ticket);
    if (!isDueAt(nowMs, base, intervalMinutes)) continue;
    const result = await send({
      db,
      tenantId,
      kind: reminderKind(ticket),
      ticket: { ...ticket, reminderIntervalMinutes: intervalMinutes },
      assignee: ticket.worker ? { name: ticket.worker, displayName: ticket.worker } : null,
    });
    if (!result?.success) continue;
    const nowIso = now.toISOString();
    db.run(`INSERT INTO ticket_reminder_state(tenant_id,ticket_id,status,last_sent_at)
      VALUES(?,?,?,?)
      ON CONFLICT(tenant_id,ticket_id,status)
      DO UPDATE SET last_sent_at=excluded.last_sent_at`,
    [tenantId, ticket.id, ticket.status, nowIso]);
    sent += 1;
  }
  return { checked: tickets.length, sent };
}

function stopReminderScheduler(tenantId) {
  const timer = reminderTimers.get(tenantId);
  if (timer) clearInterval(timer);
  reminderTimers.delete(tenantId);
}

function startReminderScheduler(tenantId, options = {}) {
  stopReminderScheduler(tenantId);
  const getDatabase = options.getDatabase || (() => options.db);
  const db = getDatabase();
  const intervals = getReminderIntervals(db, tenantId);
  const activeIntervals = Object.values(intervals).filter((value) => value > 0);
  if (!activeIntervals.length) return null;
  const tick = async () => {
    try {
      const result = await runDueReminders({ db: getDatabase(), tenantId });
      if (result.sent && options.persist) await options.persist();
    } catch (error) {
      console.warn('[工单提醒] 执行失败:', JSON.stringify({ code: 'TICKET_REMINDER_FAILED' }));
    }
  };
  const cadenceMs = Math.min(Math.min(...activeIntervals) * 60000, 60000);
  const timer = setInterval(tick, cadenceMs);
  if (typeof timer.unref === 'function') timer.unref();
  reminderTimers.set(tenantId, timer);
  void tick();
  return timer;
}

async function restoreReminderSchedulers(db, options = {}) {
  const configuredTenantIds = rows(db, `SELECT DISTINCT tenant_id FROM tenant_settings
    WHERE key IN (?, ?)`, [REMINDER_SETTING_KEY, LEGACY_REMINDER_SETTING_KEY])
    .map((row) => row.tenant_id)
    .filter((tenantId) => Object.values(getReminderIntervals(db, tenantId)).some((value) => value > 0));
  for (const tenantId of configuredTenantIds) {
    startReminderScheduler(tenantId, {
      db,
      getDatabase: options.getDatabase || (() => db),
      persist: options.persist,
    });
  }
  return configuredTenantIds.length;
}

function stopAllReminderSchedulers() {
  for (const tenantId of reminderTimers.keys()) stopReminderScheduler(tenantId);
}

module.exports = {
  REMINDER_STATUSES,
  REMINDER_SETTING_KEY,
  validateInterval,
  validateIntervals,
  getReminderInterval,
  getReminderIntervals,
  setReminderInterval,
  setReminderIntervals,
  resetTicketReminderState,
  runDueReminders,
  startReminderScheduler,
  restoreReminderSchedulers,
  stopReminderScheduler,
  stopAllReminderSchedulers,
};
