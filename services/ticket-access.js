const { isSupervisorUser } = require('./roles');

const PROCESSOR_ROLES = new Set(['worker', 'keeper']);
const STAFF_TICKET_TYPES = new Set(['repair', 'complaint', 'help']);

const STAFF_MUTABLE_FIELDS = new Set([
  'status', 'message', 'metadata', 'rejectReason', 'reject_reason', '_action',
]);
const STAFF_TRANSITIONS = new Map([
  ['wait', new Set(['doing'])],
  ['doing', new Set(['wait', 'pending', 'confirm'])],
  ['pending', new Set(['doing', 'confirm'])],
  ['confirm', new Set()],
  ['done', new Set()],
]);
const SUPERVISOR_TRANSITIONS = new Map([
  ...STAFF_TRANSITIONS,
  ['confirm', new Set(['doing', 'done'])],
]);

function ticketAccessError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function prefixed(column, alias = '') {
  return alias ? `${alias}.${column}` : column;
}

function ticketReadScope(req, alias = '', options = {}) {
  const user = req && req.user;
  const legacyEmptyTenant = options.allowLegacyEmptyTenant === true
    && options.hasTypeColumn === false;
  const tenantScope = options.hasTenantColumn === false
    ? { sql: '', params: [] }
    : {
        sql: legacyEmptyTenant
          ? ` AND (${prefixed('tenant_id', alias)} = ? OR COALESCE(${prefixed('tenant_id', alias)}, '') = '')`
          : ` AND ${prefixed('tenant_id', alias)} = ?`,
        params: [user ? user.tenant_id : null],
      };
  if (isSupervisorUser(user)) return tenantScope;
  const typeScope = options.hasTypeColumn === false
    ? ''
    : ` AND ${prefixed('type', alias)} IN ('repair', 'complaint', 'help')`;
  return {
    sql: `${tenantScope.sql} AND ${prefixed('assignee_user_id', alias)} = ?${typeScope}`,
    params: [...tenantScope.params, user ? user.id : null],
  };
}

function canReadTicket(req, ticket) {
  if (!ticket || !req || !req.user) return false;
  if (Object.prototype.hasOwnProperty.call(ticket, 'tenant_id')) {
    if (!req.user.tenant_id || String(ticket.tenant_id || '') !== String(req.user.tenant_id)) return false;
  }
  if (isSupervisorUser(req.user)) return true;
  if (!STAFF_TICKET_TYPES.has(String(ticket.type || ''))) return false;
  if (ticket.assignee_user_id == null || req.user.id == null) return false;
  return Number(ticket.assignee_user_id) === Number(req.user.id);
}

function assertTicketMutation(req, ticket, updates = {}) {
  if (!req || !req.user || !ticket) {
    throw ticketAccessError('无权操作该工单', 'TICKET_SCOPE_FORBIDDEN', 403);
  }
  const supervisor = isSupervisorUser(req.user);
  const role = String(req.user.role || '').trim().toLowerCase();
  if (!supervisor && !PROCESSOR_ROLES.has(role)) {
    throw ticketAccessError('该岗位无权处理工单', 'TICKET_SCOPE_FORBIDDEN', 403);
  }
  if (!supervisor && !STAFF_TICKET_TYPES.has(String(ticket.type || ''))) {
    throw ticketAccessError('该类型工单不开放给普通员工处理', 'TICKET_SCOPE_FORBIDDEN', 403);
  }
  if (!supervisor && !canReadTicket(req, ticket)) {
    throw ticketAccessError('无权操作该工单', 'TICKET_SCOPE_FORBIDDEN', 403);
  }
  if (!supervisor) {
    const forbidden = Object.keys(updates).filter((key) => !STAFF_MUTABLE_FIELDS.has(key));
    if (forbidden.length || updates.status === 'done') {
      throw ticketAccessError('普通员工无权修改该工单字段', 'TICKET_SCOPE_FORBIDDEN', 403);
    }
  }

  if (updates.status !== undefined && updates.status !== ticket.status) {
    const transitions = supervisor ? SUPERVISOR_TRANSITIONS : STAFF_TRANSITIONS;
    const allowed = transitions.get(String(ticket.status || ''));
    if (!allowed || !allowed.has(String(updates.status))) {
      throw ticketAccessError('工单状态转换不合法', 'INVALID_TICKET_TRANSITION', 400);
    }
  }
}

module.exports = {
  STAFF_MUTABLE_FIELDS,
  STAFF_TRANSITIONS,
  STAFF_TICKET_TYPES,
  ticketReadScope,
  canReadTicket,
  assertTicketMutation,
};
