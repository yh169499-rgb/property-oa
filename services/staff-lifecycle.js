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

function hasColumn(db, table, column) {
  try {
    return all(db, `PRAGMA table_info(${table})`).some((row) => row.name === column);
  } catch (_) {
    return false;
  }
}

function tenantMode(actorUser) {
  return Boolean(String(actorUser?.tenant_id || '').trim());
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
    tenant_id TEXT NOT NULL DEFAULT '',
    actor_user_id INTEGER NOT NULL,
    target_user_id INTEGER NOT NULL,
    target_staff_profile_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`);
  if (!hasColumn(db, 'staff_lifecycle_audit', 'tenant_id')) {
    db.run("ALTER TABLE staff_lifecycle_audit ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''");
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_staff_lifecycle_target
    ON staff_lifecycle_audit (target_user_id, action)`);
}

function writeAudit(db, values) {
  ensureLifecycleAuditSchema(db);
  db.run(`INSERT INTO staff_lifecycle_audit
    (tenant_id, actor_user_id, target_user_id, target_staff_profile_id, action, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    values.tenantId || '',
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
  const tenantId = String(actorUser.tenant_id || '').trim();
  const manager = findSupervisorProfile(db, actorUser.id, tenantId || null);
  if (!manager) throw lifecycleError('未找到当前主管档案', 'SUPERVISOR_PROFILE_NOT_FOUND', 404);
  if (tenantId) assertTeamCapacity(db, tenantId);
  else assertTeamCapacity(db, manager.id, input.role);
  const community = tenantId
    ? one(db, 'SELECT id FROM communities WHERE id = ? AND tenant_id = ?', [input.communityId, tenantId])
    : one(db, 'SELECT id FROM communities WHERE id = ?', [input.communityId]);
  if (!community) {
    throw lifecycleError('小区不存在', 'COMMUNITY_NOT_FOUND', 404);
  }

  const userColumns = ['phone', 'password', 'name', 'role', 'status'];
  const userValues = [input.phone, input.passwordHash, input.name, input.role, 'active'];
  if (hasColumn(db, 'users', 'tenant_id')) {
    userColumns.push('tenant_id');
    userValues.push(tenantId || null);
  }
  db.run(`INSERT INTO users (${userColumns.join(', ')}) VALUES (${userColumns.map(() => '?').join(', ')})`, userValues);
  const userId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
  const profileColumns = ['user_id', 'name', 'phone', 'position', 'skill', 'manager_id', 'employment_status', 'created_at', 'updated_at'];
  const profileValues = [userId, input.name, input.phone, positionForRole(input.role), input.skill, manager.id, 'active', input.nowIso, input.nowIso];
  if (hasColumn(db, 'staff_profiles', 'tenant_id')) {
    profileColumns.unshift('tenant_id');
    profileValues.unshift(tenantId || '');
  }
  db.run(`INSERT INTO staff_profiles
    (${profileColumns.join(', ')}) VALUES (${profileColumns.map(() => '?').join(', ')})`, profileValues);
  const profileId = Number(one(db, 'SELECT last_insert_rowid() AS id').id);
  const membershipColumns = ['community_id', 'staff_profile_id', 'created_at'];
  const membershipValues = [input.communityId, profileId, input.nowIso];
  if (hasColumn(db, 'community_memberships', 'tenant_id')) {
    membershipColumns.unshift('tenant_id');
    membershipValues.unshift(tenantId || '');
  }
  db.run(`INSERT INTO community_memberships
    (${membershipColumns.join(', ')}) VALUES (${membershipColumns.map(() => '?').join(', ')})`, membershipValues);
  writeAudit(db, {
    tenantId,
    actorUserId: actorUser.id,
    targetUserId: userId,
    profileId,
    action: auditAction,
    createdAt: input.nowIso,
    metadata: { role: input.role, communityId: input.communityId, ...auditMetadata },
  });
  return { userId, profileId, role: input.role, managerProfileId: manager.id, tenantId: tenantId || undefined };
}

function createStaffAccount(db, input, actorUser) {
  return inTransaction(db, () => insertStaff(db, input, actorUser));
}

function approvePendingRegistration(db, registrationId, actorUser) {
  return inTransaction(db, () => {
    assertSupervisor(actorUser);
    const tenantId = String(actorUser.tenant_id || '').trim();
    const registration = tenantId
      ? one(db, 'SELECT * FROM pending_registrations WHERE id = ? AND tenant_id = ?', [registrationId, tenantId])
      : one(db, 'SELECT * FROM pending_registrations WHERE id = ?', [registrationId]);
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
      ...(tenantId ? { tenantId } : {}),
      nowIso: new Date().toISOString(),
    }, actorUser, 'approve', { registrationId: Number(registrationId) });
    db.run("UPDATE pending_registrations SET status = 'approved' WHERE id = ? AND status = 'pending'", [registrationId]);
    return {
      ...result,
      registrationId: Number(registrationId),
      phone: registration.phone,
      name: registration.name,
      communityId: registration.community_id,
      ...(tenantId ? { tenantId } : {}),
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
    const tenantId = String(actorUser.tenant_id || '').trim();
    const user = tenantId
      ? one(db, 'SELECT * FROM users WHERE id = ? AND tenant_id = ?', [numericUserId, tenantId])
      : one(db, 'SELECT * FROM users WHERE id = ?', [numericUserId]);
    if (!user) {
      ensureLifecycleAuditSchema(db);
      const audit = one(db, `SELECT target_staff_profile_id
        FROM staff_lifecycle_audit
        WHERE target_user_id = ? AND action = 'depart'${tenantId ? ' AND tenant_id = ?' : ''}
        ORDER BY id DESC LIMIT 1`, [numericUserId, ...(tenantId ? [tenantId] : [])]);
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
    if (tenantId && !['worker', 'keeper'].includes(String(user.role || '').trim().toLowerCase())) {
      throw lifecycleError('只能办理本企业维修师傅或物业管家离职', 'STAFF_ROLE_FORBIDDEN', 403);
    }
    const targetIsSupervisor = isSupervisorUser(user);
    if (targetIsSupervisor) {
      const otherSupervisor = all(db, "SELECT * FROM users WHERE id <> ? AND COALESCE(status, 'active') = 'active'", [numericUserId])
        .some(isSupervisorUser);
      if (!otherSupervisor) throw lifecycleError('系统至少需要保留一名有效主管', 'LAST_SUPERVISOR', 409);
    }

    const profile = tenantId
      ? one(db, 'SELECT * FROM staff_profiles WHERE user_id = ? AND tenant_id = ?', [numericUserId, tenantId])
      : one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [numericUserId]);
    if (!profile) throw lifecycleError('未找到人员档案', 'STAFF_PROFILE_NOT_FOUND', 404);
    if (tenantId && !normalizedStaffRole(profile.position)) {
      throw lifecycleError('只能办理本企业维修师傅或物业管家离职', 'STAFF_ROLE_FORBIDDEN', 403);
    }
    const nowIso = actorUser.nowIso || new Date().toISOString();
    const shanghaiDate = actorUser.shanghaiDate || new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const ticketTenant = tenantId && hasColumn(db, 'tickets', 'tenant_id') ? ' AND tenant_id = ?' : '';
    const activityTenant = tenantId && hasColumn(db, 'ticket_activity_logs', 'tenant_id') ? ' AND tenant_id = ?' : '';
    db.run(`UPDATE tickets
      SET assignee_staff_profile_id = COALESCE(assignee_staff_profile_id, ?), assignee_user_id = NULL
      WHERE assignee_user_id = ?${ticketTenant}`, [profile.id, numericUserId, ...(ticketTenant ? [tenantId] : [])]);
    if (hasColumn(db, 'ticket_activity_logs', 'actor_user_id')) {
      db.run(`UPDATE ticket_activity_logs
        SET actor_staff_id = COALESCE(actor_staff_id, ?), actor_user_id = NULL
        WHERE actor_user_id = ?${activityTenant}`, [profile.id, numericUserId, ...(activityTenant ? [tenantId] : [])]);
    }
    const profileTenant = tenantId && hasColumn(db, 'staff_profiles', 'tenant_id') ? ' AND tenant_id = ?' : '';
    db.run(`UPDATE staff_profiles SET
      user_id = NULL, employment_status = 'departed', departed_at = ?,
      departed_by_user_id = ?, phone = ?, updated_at = ?
      WHERE id = ?${profileTenant}`, [nowIso, actorUser.id, maskedPhone(profile.phone || user.phone), nowIso, profile.id, ...(profileTenant ? [tenantId] : [])]);
    const membershipTenant = tenantId && hasColumn(db, 'community_memberships', 'tenant_id') ? ' AND tenant_id = ?' : '';
    db.run(`DELETE FROM community_memberships WHERE staff_profile_id = ?${membershipTenant}`, [profile.id, ...(membershipTenant ? [tenantId] : [])]);
    const shiftTenant = tenantId && hasColumn(db, 'shift_assignments', 'tenant_id') ? ' AND tenant_id = ?' : '';
    db.run(`DELETE FROM shift_assignments WHERE staff_id = ? AND work_date >= ?${shiftTenant}`, [profile.id, shanghaiDate, ...(shiftTenant ? [tenantId] : [])]);
    const statusTenant = tenantId && hasColumn(db, 'staff_status', 'tenant_id') ? ' AND tenant_id = ?' : '';
    db.run(`DELETE FROM staff_status WHERE name = ?${statusTenant}`, [profile.name, ...(statusTenant ? [tenantId] : [])]);
    writeAudit(db, {
      tenantId,
      actorUserId: actorUser.id,
      targetUserId: numericUserId,
      profileId: Number(profile.id),
      action: 'depart',
      createdAt: nowIso,
      metadata: { employmentStatus: 'departed' },
    });
    db.run(`DELETE FROM users WHERE id = ?${tenantId ? ' AND tenant_id = ?' : ''}`, [numericUserId, ...(tenantId ? [tenantId] : [])]);
    return { departed: true, userId: numericUserId, profileId: Number(profile.id), name: profile.name, tenantId: tenantId || undefined };
  });
}

module.exports = {
  createStaffAccount,
  approvePendingRegistration,
  departStaff,
  maskedPhone,
  ensureLifecycleAuditSchema,
};
