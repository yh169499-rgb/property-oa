const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

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

function provisioningError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function safeSecretEqual(left, right) {
  const digest = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function validateInput(input = {}) {
  const expectedSecret = String(input.expectedSecret || '');
  if (expectedSecret.length < 32) {
    throw provisioningError('平台初始化保护密钥至少需要 32 位', 'INVALID_PROVISIONING_SECRET', 500);
  }
  if (!safeSecretEqual(input.secret, expectedSecret)) {
    throw provisioningError('平台初始化授权失败', 'PROVISIONING_FORBIDDEN', 403);
  }
  const phone = String(input.phone || '').trim();
  const name = String(input.name || '').trim();
  const password = String(input.password || '');
  if (!/^1\d{10}$/.test(phone) || name.length < 2 || name.length > 40
      || password.length < 12 || password.length > 128) {
    throw provisioningError('平台运维账号输入无效', 'INVALID_PLATFORM_OWNER_INPUT');
  }
  return {
    phone,
    name,
    password,
    nowIso: input.nowIso || new Date().toISOString(),
  };
}

async function provisionPlatformOwner(db, rawInput = {}) {
  const input = validateInput(rawInput);
  const byPhone = one(db, 'SELECT * FROM users WHERE phone=?', [input.phone]);
  if (byPhone) {
    if (byPhone.role === 'platform_owner'
        && !byPhone.tenant_id
        && String(byPhone.status || '') === 'active') {
      return {
        created: false,
        unchanged: true,
        userId: Number(byPhone.id),
        phoneLast4: input.phone.slice(-4),
      };
    }
    throw provisioningError(
      '该手机号已属于其他账号，不能提权为平台运维',
      'PLATFORM_OWNER_PHONE_CONFLICT',
      409
    );
  }
  if (one(db, "SELECT id FROM users WHERE role='platform_owner' AND status='active'")) {
    throw provisioningError('平台运维账号已经存在', 'PLATFORM_OWNER_ALREADY_EXISTS', 409);
  }
  const passwordHash = await bcrypt.hash(input.password, 12);
  db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    if (one(db, 'SELECT id FROM users WHERE phone=?', [input.phone])) {
      throw provisioningError('该手机号已属于其他账号', 'PLATFORM_OWNER_PHONE_CONFLICT', 409);
    }
    if (one(db, "SELECT id FROM users WHERE role='platform_owner' AND status='active'")) {
      throw provisioningError('平台运维账号已经存在', 'PLATFORM_OWNER_ALREADY_EXISTS', 409);
    }
    db.run(`INSERT INTO users
      (phone,password,name,role,status,tenant_id,session_version,last_login_at)
      VALUES(?,?,?,'platform_owner','active',NULL,1,NULL)`, [
      input.phone, passwordHash, input.name,
    ]);
    const userId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
    db.run(`INSERT INTO platform_audit_logs
      (actor_user_id,action,target_type,target_id,before_json,after_json,created_at)
      VALUES(?, 'platform_owner.provision', 'user', ?, '{}', ?, ?)`, [
      userId,
      String(userId),
      JSON.stringify({ created: true, phoneLast4: input.phone.slice(-4) }),
      input.nowIso,
    ]);
    db.run('COMMIT');
    return { created: true, unchanged: false, userId, phoneLast4: input.phone.slice(-4) };
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

module.exports = { provisionPlatformOwner, safeSecretEqual };
