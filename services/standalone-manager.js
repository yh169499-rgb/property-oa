const bcrypt = require('bcryptjs');
const { isSupervisorUser } = require('./roles');

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function hasColumn(db, table, column) {
  return rows(db, `PRAGMA table_info(${table})`).some((item) => item.name === column);
}

function migrationError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeInput(input = {}) {
  const phone = String(input.phone || '').trim();
  const name = String(input.name || '').trim();
  const password = String(input.password || '');
  if (!/^1\d{10}$/.test(phone)) throw migrationError('主管手机号格式无效', 'INVALID_MANAGER_PHONE');
  if (!name) throw migrationError('主管姓名不能为空', 'INVALID_MANAGER_NAME');
  if (password.length < 8 || password.length > 128) {
    throw migrationError('主管密码长度必须为 8-128 位', 'INVALID_MANAGER_PASSWORD');
  }
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw migrationError('迁移时间无效', 'INVALID_MANAGER_TIME');
  return { phone, name, password, nowIso: now.toISOString() };
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

function ensureStandaloneManager(db, rawInput) {
  const input = normalizeInput(rawInput);
  return inTransaction(db, () => {
    let user = one(db, 'SELECT * FROM users WHERE phone = ?', [input.phone]);
    if (user && !isSupervisorUser(user)) {
      throw migrationError('该手机号已属于普通账号，不能提权为主管', 'STANDALONE_MANAGER_PHONE_CONFLICT', 409);
    }

    let created = false;
    let updated = false;
    if (!user) {
      const passwordHash = bcrypt.hashSync(input.password, 10);
      if (hasColumn(db, 'users', 'status')) {
        db.run(`INSERT INTO users (phone, password, name, role, status)
          VALUES (?, ?, ?, '主管', 'active')`, [input.phone, passwordHash, input.name]);
      } else {
        db.run(`INSERT INTO users (phone, password, name, role)
          VALUES (?, ?, ?, '主管')`, [input.phone, passwordHash, input.name]);
      }
      user = one(db, 'SELECT * FROM users WHERE phone = ?', [input.phone]);
      created = true;
    } else {
      const assignments = ['name = ?', 'role = ?'];
      const values = [input.name, '主管'];
      if (hasColumn(db, 'users', 'status')) {
        assignments.push("status = 'active'");
      }
      db.run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, [...values, user.id]);
      updated = user.name !== input.name || user.role !== '主管' || (hasColumn(db, 'users', 'status') && user.status !== 'active');
      user = one(db, 'SELECT * FROM users WHERE id = ?', [user.id]);
    }

    let profile = one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
    if (!profile) {
      db.run(`INSERT INTO staff_profiles
        (user_id, name, phone, position, manager_id, employment_status, created_at, updated_at)
        VALUES (?, ?, ?, '主管', NULL, 'active', ?, ?)`,
      [user.id, input.name, input.phone, input.nowIso, input.nowIso]);
      profile = one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
      created = true;
    } else {
      db.run(`UPDATE staff_profiles SET
        name = ?, phone = ?, position = '主管', manager_id = NULL,
        employment_status = 'active', updated_at = ?
        WHERE id = ?`, [input.name, input.phone, input.nowIso, profile.id]);
      updated = updated
        || profile.name !== input.name
        || profile.phone !== input.phone
        || profile.position !== '主管'
        || profile.manager_id !== null
        || profile.employment_status !== 'active';
      profile = one(db, 'SELECT * FROM staff_profiles WHERE id = ?', [profile.id]);
    }

    return {
      created,
      updated,
      userId: Number(user.id),
      profileId: Number(profile.id),
      phone: input.phone,
      name: input.name,
      role: '主管',
      hasMockBusinessData: false,
    };
  });
}

module.exports = { ensureStandaloneManager };
