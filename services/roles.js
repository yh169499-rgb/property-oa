const MANAGER_ROLES = new Set(['admin', 'lead', 'manager', 'supervisor', '主管', '经理']);

function isManagerRole(role) {
  return MANAGER_ROLES.has(String(role || '').trim().toLowerCase());
}

function isGlobalManagerRole(role) {
  return ['admin', 'manager', 'supervisor', '主管', '经理'].includes(String(role || '').trim().toLowerCase());
}

function isSupervisorUser(user) {
  if (!user) return false;
  if (isGlobalManagerRole(user.role)) return true;
  // 仅兼容尚未重启完成迁移的旧主管账号；启动迁移会把 lead 改为主管。
  return String(user.role || '').trim().toLowerCase() === 'lead'
    && String(user.name || '').trim() === '主管';
}

function positionForRole(role) {
  return isManagerRole(role)
    ? '主管'
    : String(role || '').toLowerCase() === 'keeper' ? '物业管家'
      : String(role || '').toLowerCase() === 'worker' ? '维修师傅' : '员工';
}

module.exports = { MANAGER_ROLES, isManagerRole, isGlobalManagerRole, isSupervisorUser, positionForRole };
