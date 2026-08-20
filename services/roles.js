const MANAGER_ROLES = new Set(['admin', 'lead', 'manager', 'supervisor', '主管', '经理']);

function isManagerRole(role) {
  return MANAGER_ROLES.has(String(role || '').trim().toLowerCase());
}

function isGlobalManagerRole(role) {
  return ['admin', 'manager', 'supervisor', '主管', '经理'].includes(String(role || '').trim().toLowerCase());
}

function isSupervisorUser(user) {
  return Boolean(user) && user.role === '主管';
}

function positionForRole(role) {
  return isManagerRole(role)
    ? '主管'
    : String(role || '').toLowerCase() === 'keeper' ? '物业管家'
      : String(role || '').toLowerCase() === 'worker' ? '维修师傅' : '员工';
}

module.exports = { MANAGER_ROLES, isManagerRole, isGlobalManagerRole, isSupervisorUser, positionForRole };
