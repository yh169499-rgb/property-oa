const { isSupervisorUser } = require('./roles');

function prefixed(column, alias = '') {
  return alias ? `${alias}.${column}` : column;
}

function ticketReadScope(req, alias = '') {
  if (isSupervisorUser(req && req.user)) return { sql: '', params: [] };
  return {
    sql: ` AND ${prefixed('assignee_user_id', alias)} = ?`,
    params: [req && req.user ? req.user.id : null],
  };
}

function canReadTicket(req, ticket) {
  if (!ticket || !req || !req.user) return false;
  if (isSupervisorUser(req.user)) return true;
  if (ticket.assignee_user_id == null || req.user.id == null) return false;
  return Number(ticket.assignee_user_id) === Number(req.user.id);
}

module.exports = { ticketReadScope, canReadTicket };
