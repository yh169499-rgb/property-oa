const bcrypt = require('bcryptjs');
const { provisionPlatformOwner } = require('./platform-provisioning');
const { TENANT_TABLES, tableExists } = require('./tenant-schema');

const CONFIRM_PHRASE = 'PROVISION-PLATFORM-BOOTSTRAP';
const OWNER_PHONE = '13222514178';
const OWNER_NAME = '句子工单管理员';
const BLANK_PHONE = '17713302589';
const BLANK_NAME = '发财';
const BLANK_TENANT_ID = 'tenant-blank-17713302589';
const BLANK_TENANT_NAME = '发财企业';

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

function bootstrapError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function validatePassword(value, name) {
  const password = String(value || '');
  if (password.length < 12 || password.length > 128) {
    throw bootstrapError(`${name} 必须为 12-128 位`, `INVALID_${name}`);
  }
  return password;
}

function businessRowsForTenant(db, tenantId) {
  return TENANT_TABLES
    .filter(table => table !== 'users' && table !== 'staff_profiles' && tableExists(db, table))
    .map(table => ({
      table,
      count: Number(one(db, `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=?`, [tenantId])?.count || 0),
    }))
    .filter(item => item.count > 0);
}

function ensureBlankSupervisorTenant(db, input) {
  const password = validatePassword(input.password, 'BLANK_SUPERVISOR_PASSWORD');
  const nowIso = input.nowIso || new Date().toISOString();

  db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const existingUser = one(db, 'SELECT * FROM users WHERE phone=?', [BLANK_PHONE]);
    if (existingUser && (existingUser.role !== '主管'
      || String(existingUser.tenant_id || '') !== BLANK_TENANT_ID)) {
      throw bootstrapError('发财账号手机号已属于其他企业或角色', 'BLANK_SUPERVISOR_PHONE_CONFLICT', 409);
    }

    const existingTenant = one(db, 'SELECT * FROM tenants WHERE id=?', [BLANK_TENANT_ID]);
    const businessRows = businessRowsForTenant(db, BLANK_TENANT_ID);
    if (businessRows.length > 0) {
      throw bootstrapError('发财企业已经存在业务数据，初始化已停止以避免覆盖', 'BLANK_TENANT_NOT_EMPTY', 409);
    }

    let user = existingUser;
    let created = false;
    let updated = false;
    if (!user) {
      const passwordHash = bcrypt.hashSync(password, 12);
      db.run(`INSERT INTO users
        (phone,password,name,role,status,tenant_id,session_version,last_login_at)
        VALUES(?,?,?,'主管','active',?,1,NULL)`, [BLANK_PHONE, passwordHash, BLANK_NAME, BLANK_TENANT_ID]);
      user = one(db, 'SELECT * FROM users WHERE phone=?', [BLANK_PHONE]);
      created = true;
    } else if (user.name !== BLANK_NAME || user.status !== 'active') {
      db.run(`UPDATE users SET name=?,role='主管',status='active',tenant_id=?,session_version=session_version+1
        WHERE id=?`, [BLANK_NAME, BLANK_TENANT_ID, user.id]);
      user = one(db, 'SELECT * FROM users WHERE id=?', [user.id]);
      updated = true;
    }

    if (!existingTenant) {
      db.run(`INSERT INTO tenants
        (id,name,status,owner_user_id,staff_limit,created_at,updated_at,disabled_at)
        VALUES(?,?, 'active', ?, 4, ?, ?, '')`,
      [BLANK_TENANT_ID, BLANK_TENANT_NAME, user.id, nowIso, nowIso]);
      created = true;
    } else {
      if (existingTenant.owner_user_id != null && Number(existingTenant.owner_user_id) !== Number(user.id)) {
        throw bootstrapError('发财企业已有其他主管，不允许覆盖', 'BLANK_TENANT_OWNER_CONFLICT', 409);
      }
      db.run(`UPDATE tenants SET name=?,status='active',owner_user_id=?,staff_limit=4,updated_at=?,disabled_at=''
        WHERE id=?`, [BLANK_TENANT_NAME, user.id, nowIso, BLANK_TENANT_ID]);
      updated = updated || existingTenant.status !== 'active'
        || Number(existingTenant.owner_user_id || 0) !== Number(user.id)
        || existingTenant.name !== BLANK_TENANT_NAME;
    }

    const existingProfile = one(db, 'SELECT * FROM staff_profiles WHERE user_id=?', [user.id]);
    if (!existingProfile) {
      db.run(`INSERT INTO staff_profiles
        (tenant_id,user_id,name,phone,position,manager_id,employment_status,departed_at,departed_by_user_id,created_at,updated_at)
        VALUES(?,?,?,?,'主管',NULL,'active','',NULL,?,?)`,
      [BLANK_TENANT_ID, user.id, BLANK_NAME, BLANK_PHONE, nowIso, nowIso]);
      created = true;
    } else {
      const profileNeedsUpdate = existingProfile.tenant_id !== BLANK_TENANT_ID
        || existingProfile.name !== BLANK_NAME
        || existingProfile.phone !== BLANK_PHONE
        || existingProfile.position !== '主管'
        || existingProfile.manager_id != null
        || existingProfile.employment_status !== 'active'
        || String(existingProfile.departed_at || '') !== ''
        || existingProfile.departed_by_user_id != null;
      if (profileNeedsUpdate) {
        db.run(`UPDATE staff_profiles SET tenant_id=?,name=?,phone=?,position='主管',manager_id=NULL,
          employment_status='active',departed_at='',departed_by_user_id=NULL,updated_at=? WHERE user_id=?`,
        [BLANK_TENANT_ID, BLANK_NAME, BLANK_PHONE, nowIso, user.id]);
        updated = true;
      }
    }

    const auditExists = tableExists(db, 'platform_audit_logs');
    if (auditExists && (created || updated)) {
      db.run(`INSERT INTO platform_audit_logs
        (actor_user_id,action,target_type,target_id,before_json,after_json,created_at)
        VALUES(?, 'blank_supervisor.provision', 'tenant', ?, '{}', ?, ?)`,
      [user.id, BLANK_TENANT_ID, JSON.stringify({ phoneLast4: BLANK_PHONE.slice(-4), created, updated }), nowIso]);
    }

    db.run('COMMIT');
    return {
      created,
      updated,
      unchanged: !created && !updated,
      userId: Number(user.id),
      tenantId: BLANK_TENANT_ID,
      phoneLast4: BLANK_PHONE.slice(-4),
      hasMockBusinessData: false,
    };
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

async function runStartupPlatformBootstrap(options = {}) {
  const env = options.env || process.env;
  if (String(env.APPLY_PLATFORM_BOOTSTRAP_ON_START || '').toLowerCase() !== 'true') {
    return { applied: false, reason: 'disabled' };
  }
  if (!options.db) throw bootstrapError('缺少数据库实例', 'PLATFORM_BOOTSTRAP_DB_MISSING', 500);
  if (String(env.PLATFORM_BOOTSTRAP_CONFIRM || '') !== CONFIRM_PHRASE) {
    throw bootstrapError(`平台初始化必须提供确认口令 ${CONFIRM_PHRASE}`, 'PLATFORM_BOOTSTRAP_CONFIRM_REQUIRED');
  }

  const platformOwnerPassword = validatePassword(env.PLATFORM_OWNER_PASSWORD, 'PLATFORM_OWNER_PASSWORD');
  const blankSupervisorPassword = validatePassword(env.BLANK_SUPERVISOR_PASSWORD, 'BLANK_SUPERVISOR_PASSWORD');
  const expectedSecret = String(env.PLATFORM_PROVISIONING_SECRET || '');
  const nowIso = options.now instanceof Date ? options.now.toISOString() : (options.nowIso || new Date().toISOString());

  const platformOwner = await provisionPlatformOwner(options.db, {
    secret: expectedSecret,
    expectedSecret,
    phone: OWNER_PHONE,
    name: OWNER_NAME,
    password: platformOwnerPassword,
    nowIso,
  });
  const blankSupervisor = ensureBlankSupervisorTenant(options.db, {
    password: blankSupervisorPassword,
    nowIso,
  });

  const summary = { platformOwner, blankSupervisor };
  if (typeof options.persist === 'function' && (
    platformOwner.created || blankSupervisor.created || blankSupervisor.updated
  )) {
    await options.persist();
  }
  return { applied: true, summary };
}

module.exports = {
  BLANK_TENANT_ID,
  CONFIRM_PHRASE,
  runStartupPlatformBootstrap,
  ensureBlankSupervisorTenant,
};
