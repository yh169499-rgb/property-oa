const { sendTicketAlert } = require('./jzm-messaging');

const reminderTimers = new Map();
const ACTIVE_STATUSES = new Set(['wait', 'doing', 'pending', 'confirm']);
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

function getReminderInterval(db, tenantId) {
  const row = one(db, `SELECT value FROM tenant_settings
    WHERE tenant_id = ? AND key = 'reminder_interval_minutes'`, [tenantId]);
  return normalizeInterval(row?.value);
}

function setReminderInterval(db, tenantId, value, now = new Date().toISOString()) {
  const intervalMinutes = normalizeInterval(value);
  db.run(`INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  [tenantId, 'reminder_interval_minutes', String(intervalMinutes), now, now]);
  return intervalMinutes;
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
  const intervalMinutes = getReminderInterval(db, tenantId);
  if (!intervalMinutes) return { checked: 0, sent: 0 };
  const tickets = rows(db, `SELECT * FROM tickets
    WHERE tenant_id = ? AND status IN ('wait','doing','pending','confirm')`, [tenantId]);
  const nowMs = now.getTime();
  let sent = 0;
  for (const ticket of tickets) {
    if (!ACTIVE_STATUSES.has(ticket.status)) continue;
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
  const intervalMinutes = getReminderInterval(db, tenantId);
  if (!intervalMinutes) return null;
  const tick = async () => {
    try {
      const result = await runDueReminders({ db: getDatabase(), tenantId });
      if (result.sent && options.persist) await options.persist();
    } catch (error) {
      console.warn('[工单提醒] 执行失败:', JSON.stringify({ code: 'TICKET_REMINDER_FAILED' }));
    }
  };
  const cadenceMs = Math.min(intervalMinutes * 60000, 60000);
  const timer = setInterval(tick, cadenceMs);
  if (typeof timer.unref === 'function') timer.unref();
  reminderTimers.set(tenantId, timer);
  void tick();
  return timer;
}

async function restoreReminderSchedulers(db, options = {}) {
  const tenants = rows(db, `SELECT tenant_id FROM tenant_settings
    WHERE key = 'reminder_interval_minutes' AND CAST(value AS REAL) > 0`);
  for (const row of tenants) {
    startReminderScheduler(row.tenant_id, {
      db,
      getDatabase: options.getDatabase || (() => db),
      persist: options.persist,
    });
  }
  return tenants.length;
}

function stopAllReminderSchedulers() {
  for (const tenantId of reminderTimers.keys()) stopReminderScheduler(tenantId);
}

module.exports = {
  getReminderInterval,
  setReminderInterval,
  resetTicketReminderState,
  runDueReminders,
  startReminderScheduler,
  restoreReminderSchedulers,
  stopReminderScheduler,
  stopAllReminderSchedulers,
};
