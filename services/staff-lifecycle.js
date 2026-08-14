const { findSupervisorProfile, assertTeamCapacity, normalizedStaffRole } = require('./team-capacity');
const { isSupervisorUser, positionForRole } = require('./roles');

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

function lifecycleError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function assertSupervisor(actorUser) {
  if (!isSupervisorUser(actorUser)) {
    throw lifecycleError('需要主管权限', 'SUPERVISOR_REQUIRED', 403);
  }
}

function inTransaction(db, work) {
  db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const value = work();
    db.run('COMMIT');
    return value;
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function ensureLifecycleAuditSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS staff_lifecycle_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER NOT NULL,
    target_user_id INTEGER NOT NULL,
    target_staff_profile_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_staff_lifecycle_target
    ON staff_lifecycle_audit (target_user_id, action)`);
}

function writeAudit(db, values) {
  ensureLifecycleAuditSchema(db);
  db.run(`INSERT INTO staff_lifecycle_audit
    (actor_user_id, target_user_id, target_staff_profile_id, action, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?)`, [
    values.actorUserId,
    values.targetUserId,
    values.profileId,
    values.action,
    values.createdAt,
    JSON.stringify(values.metadata || {}),
  ]);
}

function normalizeInput(input) {
  const role = normalizedStaffRole(input.role);
  if (!role) throw lifecycleError('只能创建维修师傅或物业管家', 'INVALID_STAFF_ROLE');
  if (!input.phone || !input.passwordHash || !input.name || !input.communityId) {
    throw lifecycleError('手机号、密码、姓名和小区必填', 'INVALID_STAFF_INPUT');
  }
  return {
    phone: String(input.phone).trim(),
    passwordHash: String(input.passwordHash),
    name: String(input.name).trim(),
    role,
    skill: String(input.skill || '').trim(),
    communityId: String(input.communityId).trim(),
    nowIso: input.nowIso || new Date().toISOString(),
  };
}

function insertStaff(db, rawInput, actorUser, auditAction = 'create', auditMetadata = {}) {
  assertSupervisor(actorUser);
  const input = normalizeInput(rawInput);
  const manager = findSupervisorProfile(db, actorUser.id);
  assertTeamCapacity(db, manager.id, input.role);
  if (!one(db, 'SELECT id FROM communities WHERE id = ?', [input.communityId])) {
    throw lifecycleError('小区不存在', 'COMMUNITY_NOT_FOUND', 404);
  }

  db.run(
    'INSERT INTO users (phone, password, name, role, status) VALUES (?, ?, ?, ?, ?)',
    [input.phone, input.passwordHash, input.name, input.role, 'active']
  );
  const userId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
  db.run(`INSERT INTO staff_profiles
    (user_id, name, phone, position, skill, manager_id, employment_status,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [
    userId, input.name, input.phone, positionForRole(input.role), input.skill,
    manager.id, input.nowIso, input.nowIso,
  ]);
  const profileId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
  db.run(`INSERT INTO community_memberships
    (community_id, staff_profile_id, created_at) VALUES (?, ?, ?)`,
  [input.communityId, profileId, input.nowIso]);
  writeAudit(db, {
    actorUserId: actorUser.id,
    targetUserId: userId,
    profileId,
    action: auditAction,
    createdAt: input.nowIso,
    metadata: { role: input.role, communityId: input.communityId, ...auditMetadata },
  });
  return { userId, profileId, role: input.role, managerProfileId: manager.id };
}

function createStaffAccount(db, input, actorUser) {
  return inTransaction(db, () => insertStaff(db, input, actorUser));
}

function approvePendingRegistration(db, registrationId, actorUser) {
  return inTransaction(db, () => {
    assertSupervisor(actorUser);
    const registration = one(db, 'SELECT * FROM pending_registrations WHERE id = ?', [registrationId]);
    if (!registration) throw lifecycleError('记录不存在', 'REGISTRATION_NOT_FOUND', 404);
    if (registration.status !== 'pending') {
      throw lifecycleError('该申请已处理', 'REGISTRATION_ALREADY_PROCESSED');
    }
    const result = insertStaff(db, {
      phone: registration.phone,
      passwordHash: registration.password,
      name: registration.name,
      role: registration.role,
      skill: registration.skill,
      communityId: registration.community_id,
      nowIso: new Date().toISOString(),
    }, actorUser, 'approve', { registrationId: Number(registrationId) });
    db.run("UPDATE pending_registrations SET status = 'approved' WHERE id = ? AND status = 'pending'", [registrationId]);
    return {
      ...result,
      registrationId: Number(registrationId),
      phone: registration.phone,
      name: registration.name,
      communityId: registration.community_id,
    };
  });
}

function maskedPhone(phone) {
  const value = String(phone || '');
  if (value.length < 7) return value ? '***' : '';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function departStaff(db, userId, actorUser) {
  assertSupervisor(actorUser);
  const numericUserId = Number(userId);
  if (numericUserId === Number(actorUser.id)) {
    throw lifecycleError('不能删除当前登录的主管账号', 'CANNOT_DEPART_SELF', 409);
  }
  return inTransaction(db, () => {
    const user = one(db, 'SELECT * FROM users WHERE id = ?', [numericUserId]);
    if (!user) {
      ensureLifecycleAuditSchema(db);
      const audit = one(db, `SELECT target_staff_profile_id
        FROM staff_lifecycle_audit
        WHERE target_user_id = ? AND action = 'depart'
        ORDER BY id DESC LIMIT 1`, [numericUserId]);
      if (audit) {
        return {
          departed: true,
          alreadyDeparted: true,
          userId: numericUserId,
          profileId: Number(audit.target_staff_profile_id),
        };
      }
      throw lifecycleError('用户不存在', 'USER_NOT_FOUND', 404);
    }
    const targetIsSupervisor = isSupervisorUser(user);
    if (targetIsSupervisor) {
      const otherSupervisor = all(db, "SELECT * FROM users WHERE id <> ? AND COALESCE(status, 'active') = 'active'", [numericUserId])
        .some(isSupervisorUser);
      if (!otherSupervisor) throw lifecycleError('系统至少需要保留一名有效主管', 'LAST_SUPERVISOR', 409);
    }

    const profile = one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [numericUserId]);
    if (!profile) throw lifecycleError('未找到人员档案', 'STAFF_PROFILE_NOT_FOUND', 404);
    const nowIso = actorUser.nowIso || new Date().toISOString();
    const shanghaiDate = actorUser.shanghaiDate || new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    db.run(`UPDATE tickets
      SET assignee_staff_profile_id = COALESCE(assignee_staff_profile_id, ?), assignee_user_id = NULL
      WHERE assignee_user_id = ?`, [profile.id, numericUserId]);
    db.run(`UPDATE ticket_activity_logs
      SET actor_staff_id = COALESCE(actor_staff_id, ?), actor_user_id = NULL
      WHERE actor_user_id = ?`, [profile.id, numericUserId]);
    db.run(`UPDATE staff_profiles SET
      user_id = NULL, employment_status = 'departed', departed_at = ?,
      departed_by_user_id = ?, phone = ?, updated_at = ?
      WHERE id = ?`, [nowIso, actorUser.id, maskedPhone(profile.phone || user.phone), nowIso, profile.id]);
    db.run('DELETE FROM community_memberships WHERE staff_profile_id = ?', [profile.id]);
    db.run('DELETE FROM shift_assignments WHERE staff_id = ? AND work_date >= ?', [profile.id, shanghaiDate]);
    db.run('DELETE FROM staff_status WHERE name = ?', [profile.name]);
    writeAudit(db, {
      actorUserId: actorUser.id,
      targetUserId: numericUserId,
      profileId: Number(profile.id),
      action: 'depart',
      createdAt: nowIso,
      metadata: { employmentStatus: 'departed' },
    });
    db.run('DELETE FROM users WHERE id = ?', [numericUserId]);
    return { departed: true, userId: numericUserId, profileId: Number(profile.id), name: profile.name };
  });
}

module.exports = {
  createStaffAccount,
  approvePendingRegistration,
  departStaff,
  maskedPhone,
  ensureLifecycleAuditSchema,
};
