const { sanitizeRequest } = require('./ticket-source-audit');

const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const RECURRENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PLACEHOLDER_LOCATIONS = new Set([
  '', '未知', '待确认', '未提供', '暂不清楚', '位置未知', '位置待确认', '地址未知', '地址待确认',
]);

function rows(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result[0]) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(
    columns.map((column, index) => [column, row[index]])
  ));
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function normalizeText(value) {
  return text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeLocation(value) {
  return normalizeText(value).replace(/[—–－]/g, '-');
}

function invalidLocationComplete() {
  const error = new Error('location_complete 必须是布尔值');
  error.status = 400;
  error.code = 'INVALID_LOCATION_COMPLETE';
  return error;
}

function parseExplicitBoolean(value) {
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'false' || value === '0') return false;
  throw invalidLocationComplete();
}

function isPlaceholderLocation(value) {
  return PLACEHOLDER_LOCATIONS.has(normalizeLocation(value));
}

function resolveLocationCompleteness(input = {}) {
  if (isPlaceholderLocation(input.loc)) return false;
  if (Object.prototype.hasOwnProperty.call(input, 'locationComplete')) {
    return parseExplicitBoolean(input.locationComplete);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'location_complete')) {
    return parseExplicitBoolean(input.location_complete);
  }
  return true;
}

function normalizeTicketType(value) {
  const type = normalizeText(value || 'repair');
  return type === 'complain' ? 'complaint' : type;
}

function canonicalOriginalMessage(input = {}) {
  return firstNonEmpty(input.message, input.original_message, input.originalMessage);
}

function feedbackPerson(input = {}) {
  return firstNonEmpty(input.feedback_person, input.feedbackPerson);
}

function feedbackGroup(input = {}) {
  return firstNonEmpty(input.feedback_group, input.feedbackGroup);
}

function repeatKeyFor(input) {
  return [
    normalizeTicketType(input.type),
    normalizeText(input.cat || '其他'),
    normalizeLocation(input.loc),
  ].join('|');
}

function createdMilliseconds(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function invalidExternalTime() {
  const error = new Error('外部工单时间不合法');
  error.status = 400;
  error.code = 'INVALID_EXTERNAL_TIME';
  return error;
}

function normalizeExternalTime(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalidExternalTime();
    return value.toISOString();
  }
  if (typeof value !== 'string') throw invalidExternalTime();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalidExternalTime();
  return new Date(parsed).toISOString();
}

function sortByCreatedDescending(candidates) {
  return candidates
    .map((ticket) => ({ ticket, createdMs: createdMilliseconds(ticket.created) }))
    .filter(({ createdMs }) => createdMs !== null)
    .sort((left, right) => right.createdMs - left.createdMs);
}

function findRecentOpenMatch(db, { tenantId, communityId, repeatKey, now }) {
  const nowMs = createdMilliseconds(now);
  if (nowMs === null) return null;
  const candidates = rows(db, `SELECT * FROM tickets
    WHERE tenant_id = ? AND community_id = ? AND repeat_key = ? AND status <> 'done'`,
  [tenantId, communityId, repeatKey]);
  return sortByCreatedDescending(candidates).find(({ createdMs }) => {
    const delta = nowMs - createdMs;
    return Number.isFinite(delta) && delta >= 0 && delta <= DUPLICATE_WINDOW_MS;
  })?.ticket || null;
}

function findCompletedMatches(db, { tenantId, communityId, repeatKey, now }) {
  const nowMs = createdMilliseconds(now);
  if (nowMs === null) return [];
  const candidates = rows(db, `SELECT * FROM tickets
    WHERE tenant_id = ? AND community_id = ? AND repeat_key = ? AND status = 'done'`,
  [tenantId, communityId, repeatKey]);
  return sortByCreatedDescending(candidates).filter(({ createdMs }) => {
    const delta = nowMs - createdMs;
    return Number.isFinite(delta) && delta >= 0 && delta <= RECURRENCE_WINDOW_MS;
  }).map(({ ticket }) => ticket);
}

function nextTicketId(db) {
  const max = one(db, `SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) value
    FROM tickets WHERE id LIKE 'WX%' AND SUBSTR(id, 3) <> ''`);
  return `WX${String((Number(max?.value) || 0) + 1).padStart(4, '0')}`;
}

function tableExists(db, table) {
  return Boolean(one(db, "SELECT 1 found FROM sqlite_master WHERE type='table' AND name=?", [table]));
}

function activePerformanceRuleId(db, tenantId) {
  if (!tableExists(db, 'performance_rule_versions')) return null;
  const active = one(db, `SELECT id FROM performance_rule_versions
    WHERE tenant_id = ? AND is_active = 1 ORDER BY version_no DESC LIMIT 1`, [tenantId]);
  if (active) return Number(active.id);
  const latest = one(db, `SELECT id FROM performance_rule_versions
    WHERE tenant_id = ? ORDER BY version_no DESC LIMIT 1`, [tenantId]);
  return latest ? Number(latest.id) : null;
}

function raiseRecurringPriority(priority) {
  const order = ['low', 'normal', 'high', 'urgent'];
  const index = order.indexOf(priority);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : priority;
}

function insertExternalTicket(db, {
  tenantId, supervisor, community, input, now, repeatKey, completedMatches,
}) {
  const ticketId = nextTicketId(db);
  const repeatOf = completedMatches[0]?.id || '';
  const repeatCount = completedMatches.length + 1;
  const recurring = Boolean(repeatOf);
  const recurrenceNote = recurring
    ? `近30天同类问题复发${repeatCount}次，关联历史工单${repeatOf}`
    : '';
  const originalMessage = canonicalOriginalMessage(input);
  const metadata = JSON.stringify({
    feedbackPerson: feedbackPerson(input),
    feedbackGroup: feedbackGroup(input),
    originalMessage,
  });
  db.run(`INSERT INTO tickets (
    tenant_id, id, type, cat, desc, loc, priority, status, worker, message,
    created, estimated_hours, session_id, community_id, repeat_key, repeat_of,
    repeat_count, is_recurring, recurrence_note, feedback_count,
    performance_rule_version_id, assignee_user_id, assignee_staff_profile_id,
    assigned_at, metadata
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'wait', '', ?, ?, 0, '', ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, '', ?)`, [
    tenantId,
    ticketId,
    normalizeTicketType(input.type),
    text(input.cat) || '其他',
    text(input.desc),
    text(input.loc),
    recurring ? raiseRecurringPriority('normal') : 'normal',
    originalMessage,
    now,
    community.id,
    repeatKey,
    repeatOf,
    repeatCount,
    recurring ? 1 : 0,
    recurrenceNote,
    activePerformanceRuleId(db, tenantId),
    metadata,
  ]);
  if (tableExists(db, 'ticket_activity_logs')) {
    db.run(`INSERT INTO ticket_activity_logs
      (tenant_id, ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)
      VALUES (?, ?, ?, NULL, 'create', ?, ?)`, [
      tenantId,
      ticketId,
      supervisor?.id ?? null,
      JSON.stringify({ type: normalizeTicketType(input.type), cat: text(input.cat) || '其他', community_id: community.id }),
      now,
    ]);
  }
  return ticketId;
}

function recordTicketSourceForInput(db, {
  tenantId, ticketId, community, input, source, now, requestJson,
}) {
  db.run(`INSERT INTO ticket_source_audits (
    tenant_id, ticket_id, enterprise_name, community_id, community_name,
    feedback_person, feedback_group, original_message, source, request_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    tenantId,
    ticketId,
    text(input.enterprise_name ?? input.enterpriseName),
    community.id,
    text(community.name),
    feedbackPerson(input),
    feedbackGroup(input),
    canonicalOriginalMessage(input),
    source,
    requestJson,
    now,
  ]);
}

function recordIngestEvent(db, {
  tenantId, communityId, ticketId, decision, normalizedLocation, repeatKey,
  input, requestJson, now,
}) {
  db.run(`INSERT INTO ticket_ingest_events (
    tenant_id, community_id, ticket_id, decision, normalized_location,
    repeat_key, feedback_person, feedback_group, original_message, request_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    tenantId,
    communityId,
    ticketId,
    decision,
    normalizedLocation,
    repeatKey,
    feedbackPerson(input),
    feedbackGroup(input),
    canonicalOriginalMessage(input),
    requestJson,
    now,
  ]);
}

function acceptExternalFeedback({ db, tenantId, supervisor, community, input = {}, now }) {
  if (!db || !tenantId || !community?.id) throw new Error('external ticket intake context is incomplete');
  const createdAt = normalizeExternalTime(now);
  const communityId = text(community.id);
  const normalizedLocation = normalizeLocation(input.loc);
  const repeatKey = repeatKeyFor(input);
  const requestJson = sanitizeRequest(input);
  let transactionStarted = false;
  try {
    db.run('BEGIN IMMEDIATE');
    transactionStarted = true;

    if (!resolveLocationCompleteness(input)) {
      recordIngestEvent(db, {
        tenantId, communityId, ticketId: null, decision: 'deferred', normalizedLocation,
        repeatKey, input, requestJson, now: createdAt,
      });
      db.run('COMMIT');
      transactionStarted = false;
      return { decision: 'deferred', ticketId: null, shouldAlert: false };
    }

    const recentOpen = findRecentOpenMatch(db, {
      tenantId, communityId, repeatKey, now: createdAt,
    });
    if (recentOpen) {
      db.run(`UPDATE tickets SET feedback_count = COALESCE(feedback_count, 1) + 1,
        repeat_key = ? WHERE tenant_id = ? AND community_id = ? AND id = ?`, [
        repeatKey, tenantId, communityId, recentOpen.id,
      ]);
      recordTicketSourceForInput(db, {
        tenantId, ticketId: recentOpen.id, community, input,
        source: 'external_merge', now: createdAt, requestJson,
      });
      recordIngestEvent(db, {
        tenantId, communityId, ticketId: recentOpen.id, decision: 'merged',
        normalizedLocation, repeatKey, input, requestJson, now: createdAt,
      });
      db.run('COMMIT');
      transactionStarted = false;
      return { decision: 'merged', ticketId: recentOpen.id, shouldAlert: false };
    }

    const completedMatches = findCompletedMatches(db, {
      tenantId, communityId, repeatKey, now: createdAt,
    });
    const ticketId = insertExternalTicket(db, {
      tenantId, supervisor, community, input, now: createdAt, repeatKey, completedMatches,
    });
    recordTicketSourceForInput(db, {
      tenantId, ticketId, community, input, source: 'external', now: createdAt, requestJson,
    });
    recordIngestEvent(db, {
      tenantId, communityId, ticketId, decision: 'created', normalizedLocation,
      repeatKey, input, requestJson, now: createdAt,
    });
    db.run('COMMIT');
    transactionStarted = false;
    return { decision: 'created', ticketId, shouldAlert: true };
  } catch (error) {
    if (transactionStarted) {
      try { db.run('ROLLBACK'); } catch (_) {}
    }
    throw error;
  }
}

module.exports = {
  acceptExternalFeedback,
  normalizeLocation,
  parseExplicitBoolean,
  resolveLocationCompleteness,
};
