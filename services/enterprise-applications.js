const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const { normalizeStaffLimit } = require('./team-capacity');

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

function serviceError(message, code, status = 400) {
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

function normalizedText(value, { field, min = 1, max = 80 } = {}) {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (text.length < min || text.length > max) {
    throw serviceError(`${field}长度必须为 ${min}—${max} 个字符`, 'INVALID_APPLICATION_INPUT');
  }
  return text;
}

function normalizeApplication(input = {}) {
  const enterpriseName = normalizedText(input.enterpriseName, { field: '企业名称', min: 2, max: 80 });
  const supervisorName = normalizedText(input.supervisorName, { field: '主管姓名', min: 2, max: 40 });
  const phone = String(input.phone || '').trim();
  const password = String(input.password || '');
  if (!/^1\d{10}$/.test(phone)) {
    throw serviceError('手机号格式不正确', 'INVALID_APPLICATION_INPUT');
  }
  if (password.length < 8 || password.length > 128) {
    throw serviceError('密码长度必须为 8—128 个字符', 'INVALID_APPLICATION_INPUT');
  }
  return { enterpriseName, supervisorName, phone, password };
}

function assertPlatformOwner(actor) {
  if (actor?.role !== 'platform_owner' || String(actor?.tenant_id || '') !== '') {
    throw serviceError('需要平台运维权限', 'PLATFORM_OWNER_REQUIRED', 403);
  }
}

function writePlatformAudit(db, actor, action, targetType, targetId, before = {}, after = {}, nowIso) {
  db.run(`INSERT INTO platform_audit_logs
    (actor_user_id,action,target_type,target_id,before_json,after_json,created_at)
    VALUES(?,?,?,?,?,?,?)`, [
    actor.id, action, targetType, String(targetId || ''),
    JSON.stringify(before), JSON.stringify(after), nowIso,
  ]);
}

async function submitEnterpriseApplication(db, rawInput, options = {}) {
  const input = normalizeApplication(rawInput);
  if (one(db, 'SELECT id FROM users WHERE phone=?', [input.phone])) {
    throw serviceError('手机号已被账号使用', 'PHONE_IN_USE', 409);
  }
  if (one(db, "SELECT id FROM enterprise_applications WHERE phone=? AND status='pending'", [input.phone])) {
    throw serviceError('该手机号已有待审核申请', 'APPLICATION_PENDING', 409);
  }
  const passwordHash = await bcrypt.hash(input.password, 12);
  const nowIso = options.nowIso || new Date().toISOString();
  try {
    db.run(`INSERT INTO enterprise_applications
      (enterprise_name,supervisor_name,phone,password_hash,status,created_at,updated_at)
      VALUES(?,?,?,?,'pending',?,?)`, [
      input.enterpriseName, input.supervisorName, input.phone, passwordHash, nowIso, nowIso,
    ]);
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      throw serviceError('该手机号已有待审核申请', 'APPLICATION_PENDING', 409);
    }
    throw error;
  }
  const id = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
  return { id, status: 'pending' };
}

function applicationForReview(db, id) {
  const application = one(db, 'SELECT * FROM enterprise_applications WHERE id=?', [id]);
  if (!application) throw serviceError('申请不存在', 'APPLICATION_NOT_FOUND', 404);
  if (application.status !== 'pending') {
    throw serviceError('该申请已经处理', 'APPLICATION_ALREADY_REVIEWED', 409);
  }
  return application;
}

function approveEnterpriseApplication(db, id, actor, options = {}) {
  assertPlatformOwner(actor);
  const staffLimit = normalizeStaffLimit(options.staffLimit, 4);
  const nowIso = options.nowIso || new Date().toISOString();
  const tenantId = String(options.tenantId || crypto.randomUUID());
  return inTransaction(db, () => {
    const application = applicationForReview(db, id);
    if (one(db, 'SELECT id FROM users WHERE phone=?', [application.phone])) {
      throw serviceError('手机号已被账号使用', 'PHONE_IN_USE', 409);
    }
    db.run(`INSERT INTO tenants
      (id,name,status,owner_user_id,staff_limit,created_at,updated_at,disabled_at)
      VALUES(?,?,'active',NULL,?,?,?,'')`, [
      tenantId, application.enterprise_name, staffLimit, nowIso, nowIso,
    ]);
    db.run(`INSERT INTO users
      (phone,password,name,role,status,tenant_id,session_version,last_login_at)
      VALUES(?,?,?,'主管','active',?,1,NULL)`, [
      application.phone, application.password_hash, application.supervisor_name, tenantId,
    ]);
    const userId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
    db.run(`INSERT INTO staff_profiles
      (tenant_id,user_id,name,phone,position,manager_id,employment_status,created_at,updated_at)
      VALUES(?,?,?,?, '主管',NULL,'active',?,?)`, [
      tenantId, userId, application.supervisor_name, application.phone, nowIso, nowIso,
    ]);
    db.run('UPDATE tenants SET owner_user_id=? WHERE id=?', [userId, tenantId]);
    db.run(`UPDATE enterprise_applications SET
      status='approved',password_hash='',reviewed_by_user_id=?,reviewed_at=?,updated_at=?
      WHERE id=? AND status='pending'`, [actor.id, nowIso, nowIso, application.id]);
    writePlatformAudit(
      db, actor, 'enterprise.approve', 'tenant', tenantId, {},
      { applicationId: Number(application.id), staffLimit }, nowIso
    );
    return { tenantId, userId, staffLimit };
  });
}

function rejectEnterpriseApplication(db, id, actor, options = {}) {
  assertPlatformOwner(actor);
  if (!String(options.reason || '').trim()) {
    throw serviceError('拒绝原因必填', 'REJECTION_REASON_REQUIRED');
  }
  const reason = normalizedText(options.reason, { field: '拒绝原因', min: 1, max: 500 });
  const nowIso = options.nowIso || new Date().toISOString();
  return inTransaction(db, () => {
    const application = applicationForReview(db, id);
    db.run(`UPDATE enterprise_applications SET
      status='rejected',password_hash='',rejection_reason=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=?
      WHERE id=? AND status='pending'`, [reason, actor.id, nowIso, nowIso, application.id]);
    writePlatformAudit(
      db, actor, 'enterprise.reject', 'enterprise_application', application.id,
      {}, { rejectionReason: reason }, nowIso
    );
    return { id: Number(application.id), status: 'rejected' };
  });
}

function listEnterpriseApplications(db, actor) {
  assertPlatformOwner(actor);
  return all(db, `SELECT
    id,enterprise_name,supervisor_name,phone,status,rejection_reason,
    reviewed_by_user_id,reviewed_at,created_at,updated_at
    FROM enterprise_applications ORDER BY created_at DESC,id DESC`);
}

module.exports = {
  submitEnterpriseApplication,
  approveEnterpriseApplication,
  rejectEnterpriseApplication,
  listEnterpriseApplications,
  assertPlatformOwner,
};
