const { queryAll, queryOne } = require('../db');

const SENSITIVE_KEYS = new Set([
  'x-jzm-ingest-token', 'x-integration-token', 'token', 'msgToken',
  'contactMap', 'contact_map', 'contacts', 'managerContactId', 'manager_contact_id',
]);

function tableExists(db, name = 'ticket_source_audits') {
  if (db?.exec) {
    const result = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]);
    return Boolean(result[0]?.values?.length);
  }
  return Boolean(queryOne("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]));
}

function normalizeSourceFields(input = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const pick = (...keys) => keys
    .map((key) => input[key] ?? metadata[key])
    .find((value) => value !== undefined && value !== null && String(value).trim() !== '') || '';
  return {
    enterpriseName: String(pick('enterprise_name', 'enterpriseName', 'company_name', 'companyName', 'tenant_name', 'tenantName')).trim(),
    communityName: String(pick('community_name', 'communityName')).trim(),
    feedbackPerson: String(pick('feedback_person', 'feedbackPerson', 'sender_name', 'senderName')).trim(),
    feedbackGroup: String(pick('feedback_group', 'feedbackGroup', 'group_name', 'groupName')).trim(),
    // 部分外部调用方只提供 message；在未显式传原文时保留它，避免预警丢失居民正文。
    originalMessage: String(pick('original_message', 'originalMessage', 'message')).trim(),
  };
}

function sanitizeRequest(input = {}) {
  const sanitize = (value, key = '') => {
    if (SENSITIVE_KEYS.has(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
    }
    return value;
  };
  return JSON.stringify(sanitize(input));
}

function recordTicketSource(db, {
  tenantId, ticketId, input = {}, communityId = '', communityName = '', source = 'external', createdAt = new Date().toISOString(),
}) {
  if (!tenantId || !ticketId || !tableExists(db)) return null;
  const normalized = normalizeSourceFields(input);
  const resolvedCommunityName = String(communityName || normalized.communityName || '').trim();
  const sql = `INSERT INTO ticket_source_audits
    (tenant_id, ticket_id, enterprise_name, community_id, community_name,
     feedback_person, feedback_group, original_message, source, request_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [tenantId, ticketId, normalized.enterpriseName, String(communityId || '').trim(),
    resolvedCommunityName, normalized.feedbackPerson, normalized.feedbackGroup,
    normalized.originalMessage, source, sanitizeRequest(input), createdAt];
  if (db?.run) db.run(sql, params);
  else require('../db').run(sql, params);
  return queryOne(`SELECT * FROM ticket_source_audits WHERE tenant_id = ? AND ticket_id = ?
    ORDER BY id DESC LIMIT 1`, [tenantId, ticketId]);
}

function listTicketSources({ tenantId, ticketId = '', communityId = '', from = '', to = '' } = {}) {
  const filters = ['tenant_id = ?'];
  const params = [tenantId];
  if (ticketId) { filters.push('ticket_id = ?'); params.push(ticketId); }
  if (communityId) { filters.push('community_id = ?'); params.push(communityId); }
  if (from) { filters.push('created_at >= ?'); params.push(from); }
  if (to) { filters.push('created_at <= ?'); params.push(to); }
  return queryAll(`SELECT id, tenant_id, ticket_id, enterprise_name, community_id, community_name,
    feedback_person, feedback_group, original_message, source, created_at
    FROM ticket_source_audits WHERE ${filters.join(' AND ')} ORDER BY created_at DESC, id DESC`, params);
}

module.exports = {
  normalizeSourceFields,
  sanitizeRequest,
  recordTicketSource,
  listTicketSources,
  tableExists,
};
