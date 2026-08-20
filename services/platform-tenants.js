const bcrypt = require('bcryptjs');

const { normalizeStaffLimit } = require('./team-capacity');
const { assertPlatformOwner } = require('./enterprise-applications');

function all(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) {
  return all(db, sql, params)[0] || null;
}

function platformError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function inTransaction(db, work) {
  db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = work();
    db.run('COMMIT');
    return result;
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function tenantOrThrow(db, tenantId) {
  const tenant = one(db, 'SELECT * FROM tenants WHERE id=?', [tenantId]);
  if (!tenant) throw platformError('企业不存在', 'TENANT_NOT_FOUND', 404);
  return tenant;
}

function writeAudit(db, actor, action, tenantId, before, after, nowIso) {
  db.run(`INSERT INTO platform_audit_logs
    (actor_user_id,action,target_type,target_id,before_json,after_json,created_at)
    VALUES(?,?,'tenant',?,?,?,?)`, [
    actor.id, action, tenantId, JSON.stringify(before || {}), JSON.stringify(after || {}), nowIso,
  ]);
}

function activeStaffCount(db, tenantId) {
  return Number(one(db, `SELECT COUNT(*) AS count FROM staff_profiles
    WHERE tenant_id=? AND employment_status='active'
      AND position NOT IN ('主管','平台管理员','platform_owner')`, [tenantId])?.count || 0);
}

function listTenants(db, actor) {
  assertPlatformOwner(actor);
  return all(db, `SELECT
      t.id,t.name,t.status,t.created_at,t.staff_limit,
      u.name AS supervisor_name,u.phone AS supervisor_phone,
      u.last_login_at AS supervisor_last_login_at,
      (SELECT COUNT(*) FROM staff_profiles sp
        WHERE sp.tenant_id=t.id AND sp.employment_status='active'
          AND sp.position NOT IN ('主管','平台管理员','platform_owner')) AS active_staff_count,
      (SELECT COUNT(*) FROM communities c WHERE c.tenant_id=t.id) AS community_count,
      (SELECT COUNT(*) FROM tickets k WHERE k.tenant_id=t.id) AS ticket_count
    FROM tenants t
    LEFT JOIN users u ON u.id=t.owner_user_id AND u.tenant_id=t.id AND u.role='主管'
    ORDER BY t.created_at,t.id`)
    .map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      created_at: row.created_at,
      supervisor_name: row.supervisor_name || '',
      supervisor_phone: row.supervisor_phone || '',
      supervisor_last_login_at: row.supervisor_last_login_at || null,
      active_staff_count: Number(row.active_staff_count || 0),
      staff_limit: Number(row.staff_limit),
      community_count: Number(row.community_count || 0),
      ticket_count: Number(row.ticket_count || 0),
    }));
}

function normalizeTenantName(value) {
  const name = String(value || '').trim().replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (name.length < 2 || name.length > 80) {
    throw platformError('企业名称长度必须为 2—80 个字符', 'INVALID_TENANT_NAME');
  }
  return name;
}

function updateTenant(db, tenantId, actor, input = {}) {
  assertPlatformOwner(actor);
  const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
  const hasLimit = Object.prototype.hasOwnProperty.call(input, 'staffLimit');
  if (!hasName && !hasLimit) {
    throw platformError('没有可修改的企业字段', 'TENANT_UPDATE_EMPTY');
  }
  const name = hasName ? normalizeTenantName(input.name) : null;
  const staffLimit = hasLimit ? normalizeStaffLimit(input.staffLimit) : null;
  const nowIso = input.nowIso || new Date().toISOString();
  return inTransaction(db, () => {
    const tenant = tenantOrThrow(db, tenantId);
    const nextName = hasName ? name : tenant.name;
    const nextLimit = hasLimit ? staffLimit : Number(tenant.staff_limit);
    const activeCount = activeStaffCount(db, tenantId);
    if (nextLimit < activeCount) {
      const error = platformError(
        '人员上限不能低于当前在职人数',
        'STAFF_LIMIT_BELOW_ACTIVE_COUNT',
        409
      );
      error.details = { activeStaffCount: activeCount, requestedStaffLimit: nextLimit };
      throw error;
    }
    db.run('UPDATE tenants SET name=?,staff_limit=?,updated_at=? WHERE id=?', [
      nextName, nextLimit, nowIso, tenantId,
    ]);
    writeAudit(
      db, actor, 'tenant.update', tenantId,
      { name: tenant.name, staffLimit: Number(tenant.staff_limit) },
      { name: nextName, staffLimit: nextLimit }, nowIso
    );
    return one(db, 'SELECT id,name,status,staff_limit,updated_at FROM tenants WHERE id=?', [tenantId]);
  });
}

function setTenantStatus(db, tenantId, actor, status, options = {}) {
  assertPlatformOwner(actor);
  if (!['active', 'disabled'].includes(status)) {
    throw platformError('企业状态无效', 'INVALID_TENANT_STATUS');
  }
  const nowIso = options.nowIso || new Date().toISOString();
  return inTransaction(db, () => {
    const tenant = tenantOrThrow(db, tenantId);
    if (tenant.status === status) {
      return { id: tenant.id, status: tenant.status, unchanged: true };
    }
    db.run('UPDATE tenants SET status=?,disabled_at=?,updated_at=? WHERE id=?', [
      status, status === 'disabled' ? nowIso : '', nowIso, tenantId,
    ]);
    db.run('UPDATE users SET session_version=session_version+1 WHERE tenant_id=?', [tenantId]);
    writeAudit(
      db, actor, status === 'disabled' ? 'tenant.disable' : 'tenant.restore', tenantId,
      { status: tenant.status }, { status }, nowIso
    );
    return { id: tenant.id, status, unchanged: false };
  });
}

async function resetTenantSupervisorPassword(db, tenantId, actor, input = {}) {
  assertPlatformOwner(actor);
  const password = String(input.password || '');
  if (password.length < 12 || password.length > 128) {
    throw platformError('主管密码长度必须为 12—128 个字符', 'INVALID_SUPERVISOR_PASSWORD');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const nowIso = input.nowIso || new Date().toISOString();
  return inTransaction(db, () => {
    const tenant = tenantOrThrow(db, tenantId);
    const supervisor = one(db, `SELECT id FROM users
      WHERE id=? AND tenant_id=? AND role='主管'`, [tenant.owner_user_id, tenantId]);
    if (!supervisor) {
      throw platformError('企业主管不存在', 'TENANT_SUPERVISOR_NOT_FOUND', 409);
    }
    db.run(`UPDATE users SET password=?,session_version=session_version+1
      WHERE id=? AND tenant_id=?`, [passwordHash, supervisor.id, tenantId]);
    writeAudit(
      db, actor, 'tenant.reset_supervisor_password', tenantId,
      {}, { supervisorUserId: Number(supervisor.id), reset: true }, nowIso
    );
    return { tenantId, supervisorUserId: Number(supervisor.id), sessionRevoked: true };
  });
}

module.exports = {
  listTenants,
  updateTenant,
  setTenantStatus,
  resetTenantSupervisorPassword,
  activeStaffCount,
};
