const bcrypt = require('bcryptjs');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { resolveShiftWindow } = require('./shifts');

const RETAINED_ACCOUNTS = Object.freeze([
  { phone: '13800000001', name: '主管', role: '主管', position: '主管', birthMonth: '1988-06', joinDate: '2021-03-15', skill: '团队管理' },
  { phone: '13800000002', name: '张师傅', role: 'worker', position: '维修师傅', birthMonth: '1985-02', joinDate: '2022-04-08', skill: '水暖' },
  { phone: '13800000003', name: '李师傅', role: 'worker', position: '维修师傅', birthMonth: '1987-07', joinDate: '2022-07-18', skill: '电路' },
  { phone: '13800000004', name: '王师傅', role: 'worker', position: '维修师傅', birthMonth: '1990-11', joinDate: '2023-02-10', skill: '电器' },
  { phone: '13800000005', name: '赵师傅', role: 'worker', position: '维修师傅', birthMonth: '1989-09', joinDate: '2023-06-20', skill: '门窗' },
  { phone: '13800000006', name: '陈管家', role: 'keeper', position: '物业管家', birthMonth: '1992-03', joinDate: '2022-09-12', skill: '客户服务' },
  { phone: '13800000007', name: '周管家', role: 'keeper', position: '物业管家', birthMonth: '1993-12', joinDate: '2024-01-08', skill: '社区协调' },
]);

const MOCK_COMMUNITY = Object.freeze({
  id: 'mock-e2e-community',
  name: '全流程测试小区',
  address: '模拟数据专用，不用于真实业务',
});

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

function tableExists(db, table) {
  return Boolean(one(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]));
}

function columnExists(db, table, column) {
  return rows(db, `PRAGMA table_info(${table})`).some(item => item.name === column);
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!columnExists(db, table, column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function ensureRetainedMigrationSchema(db) {
  addColumn(db, 'users', "status TEXT NOT NULL DEFAULT 'active'");
  for (const definition of [
    "community_id TEXT DEFAULT 'default'",
    "repeat_key TEXT DEFAULT ''",
    "repeat_of TEXT DEFAULT ''",
    'repeat_count INTEGER DEFAULT 1',
    'is_recurring INTEGER DEFAULT 0',
    "recurrence_note TEXT DEFAULT ''",
    'feedback_count INTEGER DEFAULT 1',
    "metadata TEXT DEFAULT '{}'",
  ]) addColumn(db, 'tickets', definition);
}

function planRetainedTestData(db) {
  const retainedPhones = new Set(RETAINED_ACCOUNTS.map(account => account.phone));
  const users = tableExists(db, 'users') ? rows(db, 'SELECT phone FROM users') : [];
  return {
    summary: {
      retainedAccounts: RETAINED_ACCOUNTS.length,
      disabledAccounts: users.filter(user => !retainedPhones.has(String(user.phone))).length,
    },
  };
}

function requireMigrationOptions(options = {}) {
  if (!options.password) throw new Error('缺少 RETAINED_TEST_PASSWORD');
  const now = new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('迁移时间无效');
  return { ...options, now, nowIso: now.toISOString() };
}

function upsertRetainedUsers(db, password) {
  const users = new Map();
  for (const account of RETAINED_ACCOUNTS) {
    let user = one(db, 'SELECT * FROM users WHERE phone = ?', [account.phone]);
    const passwordHash = user && bcrypt.compareSync(password, String(user.password || ''))
      ? user.password
      : bcrypt.hashSync(password, 10);
    if (user) {
      db.run(`UPDATE users
        SET password = ?, name = ?, role = ?, status = 'active'
        WHERE id = ?`, [passwordHash, account.name, account.role, user.id]);
    } else {
      db.run(`INSERT INTO users (phone, password, name, role, status)
        VALUES (?, ?, ?, ?, 'active')`, [account.phone, passwordHash, account.name, account.role]);
    }
    user = one(db, 'SELECT * FROM users WHERE phone = ?', [account.phone]);
    users.set(account.phone, user);
  }
  return users;
}

function disableOtherUsers(db, retainedPhones, nowIso, today) {
  const inactiveUsers = rows(
    db,
    `SELECT id, name FROM users WHERE phone NOT IN (${retainedPhones.map(() => '?').join(', ')})`,
    retainedPhones
  );
  if (!inactiveUsers.length) return;
  const userIds = inactiveUsers.map(user => Number(user.id));
  const placeholders = userIds.map(() => '?').join(', ');
  const profiles = rows(db, `SELECT id, name FROM staff_profiles WHERE user_id IN (${placeholders})`, userIds);
  db.run(`UPDATE users SET status = 'disabled' WHERE id IN (${placeholders})`, userIds);
  if (!profiles.length) return;
  const profileIds = profiles.map(profile => Number(profile.id));
  const profilePlaceholders = profileIds.map(() => '?').join(', ');
  db.run(`UPDATE staff_profiles SET employment_status = 'inactive', updated_at = ?
    WHERE id IN (${profilePlaceholders})`, [nowIso, ...profileIds]);
  db.run(`DELETE FROM community_memberships WHERE staff_profile_id IN (${profilePlaceholders})`, profileIds);
  db.run(`DELETE FROM shift_assignments
    WHERE staff_id IN (${profilePlaceholders}) AND work_date >= ?`, [...profileIds, today]);
  db.run(`DELETE FROM attendance_records WHERE staff_id IN (${profilePlaceholders})`, profileIds);
  if (tableExists(db, 'attendance_change_logs')) {
    db.run('DELETE FROM attendance_change_logs WHERE attendance_id NOT IN (SELECT id FROM attendance_records)');
  }
  if (tableExists(db, 'staff_status')) {
    const names = profiles.map(profile => String(profile.name || '')).filter(Boolean);
    if (names.length) {
      db.run(`DELETE FROM staff_status WHERE name IN (${names.map(() => '?').join(', ')})`, names);
    }
  }
}

function upsertProfiles(db, users, nowIso) {
  const profiles = new Map();
  for (const account of RETAINED_ACCOUNTS) {
    const user = users.get(account.phone);
    let profile = one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
    if (!profile) {
      db.run(`INSERT INTO staff_profiles
        (user_id, name, birth_month, join_date, phone, position, skill,
         employment_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [
        user.id, account.name, account.birthMonth, account.joinDate, account.phone,
        account.position, account.skill, nowIso, nowIso,
      ]);
    } else {
      db.run(`UPDATE staff_profiles SET
        name = ?, birth_month = COALESCE(NULLIF(birth_month, ''), ?),
        join_date = COALESCE(NULLIF(join_date, ''), ?), phone = ?, position = ?,
        skill = COALESCE(NULLIF(skill, ''), ?), employment_status = 'active', updated_at = ?
        WHERE id = ?`, [
        account.name, account.birthMonth, account.joinDate, account.phone,
        account.position, account.skill, nowIso, profile.id,
      ]);
    }
    profile = one(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
    profiles.set(account.phone, profile);
  }
  const supervisorId = Number(profiles.get(RETAINED_ACCOUNTS[0].phone).id);
  db.run('UPDATE staff_profiles SET manager_id = NULL WHERE id = ?', [supervisorId]);
  const subordinateIds = RETAINED_ACCOUNTS.slice(1).map(account => Number(profiles.get(account.phone).id));
  db.run(`UPDATE staff_profiles SET manager_id = ?
    WHERE id IN (${subordinateIds.map(() => '?').join(', ')})`, [supervisorId, ...subordinateIds]);
  return profiles;
}

function upsertCommunitiesAndMemberships(db, profiles, supervisorUserId, nowIso) {
  if (!one(db, "SELECT id FROM communities WHERE id = 'default'")) {
    db.run("INSERT INTO communities (id, name, address, created) VALUES ('default', '默认小区', '', ?)", [nowIso]);
  }
  if (!one(db, 'SELECT id FROM communities WHERE id = ?', [MOCK_COMMUNITY.id])) {
    db.run('INSERT INTO communities (id, name, address, created) VALUES (?, ?, ?, ?)', [
      MOCK_COMMUNITY.id, MOCK_COMMUNITY.name, MOCK_COMMUNITY.address, nowIso,
    ]);
  } else {
    db.run('UPDATE communities SET name = ?, address = ? WHERE id = ?', [
      MOCK_COMMUNITY.name, MOCK_COMMUNITY.address, MOCK_COMMUNITY.id,
    ]);
  }
  for (const account of RETAINED_ACCOUNTS) {
    const profileId = Number(profiles.get(account.phone).id);
    db.run(`INSERT OR IGNORE INTO community_memberships
      (community_id, staff_profile_id, created_at, created_by_user_id)
      VALUES ('default', ?, ?, ?)`, [profileId, nowIso, supervisorUserId]);
  }
  for (const phone of ['13800000001', '13800000002', '13800000006']) {
    db.run(`INSERT OR IGNORE INTO community_memberships
      (community_id, staff_profile_id, created_at, created_by_user_id)
      VALUES (?, ?, ?, ?)`, [MOCK_COMMUNITY.id, profiles.get(phone).id, nowIso, supervisorUserId]);
  }
}

function shanghaiDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function offsetDate(now, offset) {
  return shanghaiDate(new Date(now.getTime() + offset * 86400000));
}

function isoAtShanghai(date, hour, minute = 0) {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`).toISOString();
}

function upsertShiftTemplate(db, template, supervisorUserId) {
  const existing = one(db, 'SELECT id FROM shift_templates WHERE name = ?', [template.name]);
  if (existing) {
    db.run(`UPDATE shift_templates SET start_time = ?, end_time = ?, color = ?,
      grace_minutes = ?, created_by = ? WHERE id = ?`, [
      template.startTime, template.endTime, template.color, template.graceMinutes,
      supervisorUserId, existing.id,
    ]);
    return Number(existing.id);
  }
  db.run(`INSERT INTO shift_templates
    (name, start_time, end_time, color, grace_minutes, created_by)
    VALUES (?, ?, ?, ?, ?, ?)`, [
    template.name, template.startTime, template.endTime, template.color,
    template.graceMinutes, supervisorUserId,
  ]);
  return Number(one(db, 'SELECT id FROM shift_templates WHERE id = last_insert_rowid()').id);
}

function insertMockAssignment(db, value, supervisorUserId, nowIso) {
  const conflict = one(db,
    'SELECT id, note FROM shift_assignments WHERE staff_id = ? AND work_date = ?',
    [value.staffId, value.workDate]
  );
  if (conflict && !String(conflict.note || '').startsWith('MOCK-E2E')) return false;
  if (conflict) db.run('DELETE FROM shift_assignments WHERE id = ?', [conflict.id]);
  db.run(`INSERT INTO shift_assignments
    (staff_id, work_date, assignment_type, template_id, start_at, end_at,
     leave_type, note, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    value.staffId, value.workDate, value.assignmentType, value.templateId,
    value.startAt, value.endAt, value.leaveType || null, value.note,
    supervisorUserId, nowIso,
  ]);
  return true;
}

function seedMockCalendar(db, profiles, supervisorUserId, now, nowIso) {
  db.run("DELETE FROM shift_assignments WHERE note LIKE 'MOCK-E2E%'");
  const dayTemplate = upsertShiftTemplate(db, {
    name: '模拟白班', startTime: '08:00', endTime: '18:00',
    color: '#2f6fed', graceMinutes: 5,
  }, supervisorUserId);
  const nightTemplate = upsertShiftTemplate(db, {
    name: '模拟夜班', startTime: '22:00', endTime: '06:00',
    color: '#6f52d9', graceMinutes: 10,
  }, supervisorUserId);
  const ordinary = RETAINED_ACCOUNTS.slice(1);
  ordinary.forEach((account, accountIndex) => {
    [-2, -1, 0].forEach((offset, dayIndex) => {
      const workDate = offsetDate(now, offset + (accountIndex % 2));
      const isLeave = account.phone === '13800000005' && dayIndex === 1;
      const isOvernight = account.phone === '13800000004' && dayIndex === 0;
      if (isLeave) {
        insertMockAssignment(db, {
          staffId: Number(profiles.get(account.phone).id), workDate,
          assignmentType: 'leave', templateId: null, startAt: null, endAt: null,
          leaveType: '事假', note: 'MOCK-E2E-LEAVE',
        }, supervisorUserId, nowIso);
        return;
      }
      const templateId = isOvernight ? nightTemplate : dayTemplate;
      const window = resolveShiftWindow(workDate, isOvernight ? '22:00' : '08:00', isOvernight ? '06:00' : '18:00');
      insertMockAssignment(db, {
        staffId: Number(profiles.get(account.phone).id), workDate,
        assignmentType: 'work', templateId, startAt: window.startAt, endAt: window.endAt,
        leaveType: null, note: isOvernight ? 'MOCK-E2E-OVERNIGHT' : `MOCK-E2E-DAY-${account.phone.slice(-2)}-${dayIndex}`,
      }, supervisorUserId, nowIso);
    });
  });
}

function clearAttendanceHistory(db) {
  if (tableExists(db, 'attendance_change_logs')) db.run('DELETE FROM attendance_change_logs');
  if (tableExists(db, 'attendance_records')) db.run('DELETE FROM attendance_records');
}

function upsertMockTicket(db, ticket) {
  const existing = one(db, 'SELECT id FROM tickets WHERE id = ?', [ticket.id]);
  const columns = [
    'type', 'cat', 'desc', 'loc', 'priority', 'status', 'worker', 'message',
    'created', 'finished', 'reject_reason', 'estimated_hours', 'community_id',
    'repeat_key', 'repeat_of', 'repeat_count', 'is_recurring', 'recurrence_note',
    'feedback_count', 'metadata', 'assignee_user_id', 'assigned_at',
    'performance_rule_version_id',
  ];
  const values = columns.map(column => ticket[column]);
  if (existing) {
    db.run(`UPDATE tickets SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`, [
      ...values, ticket.id,
    ]);
  } else {
    db.run(`INSERT INTO tickets (id, ${columns.join(', ')})
      VALUES (?, ${columns.map(() => '?').join(', ')})`, [ticket.id, ...values]);
  }
}

function upsertMockActivity(db, activity) {
  const metadata = JSON.stringify({ mock_key: activity.key, scenario: activity.scenario });
  if (one(db, 'SELECT id FROM ticket_activity_logs WHERE ticket_id = ? AND metadata = ?', [activity.ticketId, metadata])) return;
  db.run(`INSERT INTO ticket_activity_logs
    (ticket_id, actor_user_id, actor_staff_id, action, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [
    activity.ticketId, activity.actorUserId, activity.actorStaffId,
    activity.action, metadata, activity.createdAt,
  ]);
}

function seedMockTickets(db, users, profiles, now) {
  const supervisor = users.get('13800000001');
  const supervisorProfile = profiles.get('13800000001');
  const rule = one(db, 'SELECT id FROM performance_rule_versions WHERE is_active = 1 ORDER BY version_no DESC LIMIT 1')
    || one(db, 'SELECT id FROM performance_rule_versions ORDER BY version_no DESC LIMIT 1');
  const currentStatuses = ['doing', 'pending', 'confirm', 'doing', 'pending', 'confirm'];
  RETAINED_ACCOUNTS.slice(1).forEach((account, accountIndex) => {
    const user = users.get(account.phone);
    const profile = profiles.get(account.phone);
    for (let index = 1; index <= 5; index += 1) {
      const workDate = offsetDate(now, -(index + accountIndex));
      const assignedAt = isoAtShanghai(workDate, 8 + (index % 3), 10);
      const duration = index === 4 ? 3 : 1 + (index % 2) * 0.5;
      const finished = new Date(Date.parse(assignedAt) + duration * 3600000).toISOString();
      const ticketId = `MOCK-E2E-${account.phone.slice(-2)}-DONE-${String(index).padStart(2, '0')}`;
      const recurring = index === 2 && accountIndex === 0;
      const multiFeedback = index === 3 && accountIndex === 1;
      const returned = index === 4 && accountIndex === 2;
      upsertMockTicket(db, {
        id: ticketId, type: account.role === 'keeper' ? 'help' : 'repair',
        cat: ['水暖', '电路', '电器', '门窗', '公共设施'][index - 1],
        desc: `全流程模拟已完成工单 ${account.name}-${index}`,
        loc: `${accountIndex + 1}栋-${100 + index}`, priority: index === 5 ? 'urgent' : 'normal',
        status: 'done', worker: account.name, message: `模拟处理说明 ${index}`,
        created: new Date(Date.parse(assignedAt) - 30 * 60000).toISOString(),
        finished, reject_reason: returned ? '首次处理后由管家退回复核' : '',
        estimated_hours: 2, community_id: accountIndex % 2 ? 'default' : MOCK_COMMUNITY.id,
        repeat_key: recurring ? 'MOCK-E2E-RECURRING-WATER' : '', repeat_of: '',
        repeat_count: recurring ? 2 : 1, is_recurring: recurring ? 1 : 0,
        recurrence_note: recurring ? '同位置问题再次发生' : '',
        feedback_count: multiFeedback ? 3 : 1,
        metadata: JSON.stringify({ mock: true, scenario: 'completed-flow' }),
        assignee_user_id: Number(user.id), assigned_at: assignedAt,
        performance_rule_version_id: Number(rule.id),
      });
      [
        { key: `${ticketId}:assign`, action: 'assign', actorUserId: Number(supervisor.id), actorStaffId: Number(supervisorProfile.id), at: assignedAt },
        { key: `${ticketId}:accept`, action: 'accept', actorUserId: Number(user.id), actorStaffId: Number(profile.id), at: new Date(Date.parse(assignedAt) + 5 * 60000).toISOString() },
        { key: `${ticketId}:complete`, action: returned ? 'reject_then_complete' : 'complete', actorUserId: Number(user.id), actorStaffId: Number(profile.id), at: finished },
      ].forEach(event => upsertMockActivity(db, {
        ticketId, key: event.key, scenario: 'completed-flow',
        actorUserId: event.actorUserId, actorStaffId: event.actorStaffId,
        action: event.action, createdAt: event.at,
      }));
    }
    const workDate = account.phone === '13800000005'
      ? offsetDate(now, 0)
      : offsetDate(now, accountIndex % 2);
    const assignedAt = isoAtShanghai(workDate, 9 + accountIndex, 0);
    const ticketId = `MOCK-E2E-${account.phone.slice(-2)}-CURRENT`;
    upsertMockTicket(db, {
      id: ticketId, type: account.role === 'keeper' ? 'complaint' : 'repair',
      cat: '公共设施', desc: `全流程模拟当前工单 ${account.name}`,
      loc: `${accountIndex + 1}栋-公共区域`, priority: accountIndex === 0 ? 'urgent' : 'normal',
      status: currentStatuses[accountIndex], worker: account.name,
      message: '模拟当前处理进度', created: new Date(Date.parse(assignedAt) - 20 * 60000).toISOString(),
      finished: '', reject_reason: '', estimated_hours: 2,
      community_id: accountIndex % 2 ? 'default' : MOCK_COMMUNITY.id,
      repeat_key: '', repeat_of: '', repeat_count: 1, is_recurring: 0,
      recurrence_note: '', feedback_count: 1,
      metadata: JSON.stringify({ mock: true, scenario: 'current-flow' }),
      assignee_user_id: Number(user.id), assigned_at: assignedAt,
      performance_rule_version_id: Number(rule.id),
    });
    [
      { key: `${ticketId}:assign`, action: 'assign', actorUserId: Number(supervisor.id), actorStaffId: Number(supervisorProfile.id) },
      { key: `${ticketId}:accept`, action: 'accept', actorUserId: Number(user.id), actorStaffId: Number(profile.id) },
    ].forEach((event, index) => upsertMockActivity(db, {
      ticketId, key: event.key, scenario: 'current-flow',
      actorUserId: event.actorUserId, actorStaffId: event.actorStaffId,
      action: event.action, createdAt: new Date(Date.parse(assignedAt) + index * 5 * 60000).toISOString(),
    }));
  });
  const conflictAccount = RETAINED_ACCOUNTS.find(account => account.phone === '13800000002');
  const conflictUser = users.get(conflictAccount.phone);
  const conflictProfile = profiles.get(conflictAccount.phone);
  const conflictDate = offsetDate(now, 0);
  const conflictAssignedAt = isoAtShanghai(conflictDate, 10, 0);
  const conflictId = 'MOCK-E2E-02-CONFLICT';
  upsertMockTicket(db, {
    id: conflictId, type: 'repair', cat: '电路', desc: '全流程模拟日程冲突工单',
    loc: '测试小区-配电间', priority: 'high', status: 'doing',
    worker: conflictAccount.name, message: '与当前工单时间重叠',
    created: new Date(Date.parse(conflictAssignedAt) - 10 * 60000).toISOString(),
    finished: '', reject_reason: '', estimated_hours: 2,
    community_id: MOCK_COMMUNITY.id, repeat_key: '', repeat_of: '', repeat_count: 1,
    is_recurring: 0, recurrence_note: '', feedback_count: 1,
    metadata: JSON.stringify({ mock: true, scenario: 'calendar-conflict' }),
    assignee_user_id: Number(conflictUser.id), assigned_at: conflictAssignedAt,
    performance_rule_version_id: Number(rule.id),
  });
  [
    { key: `${conflictId}:assign`, action: 'assign', actorUserId: Number(supervisor.id), actorStaffId: Number(supervisorProfile.id) },
    { key: `${conflictId}:accept`, action: 'accept', actorUserId: Number(conflictUser.id), actorStaffId: Number(conflictProfile.id) },
  ].forEach((event, index) => upsertMockActivity(db, {
    ticketId: conflictId, key: event.key, scenario: 'calendar-conflict',
    actorUserId: event.actorUserId, actorStaffId: event.actorStaffId,
    action: event.action,
    createdAt: new Date(Date.parse(conflictAssignedAt) + index * 5 * 60000).toISOString(),
  }));
  const waitDate = offsetDate(now, 0);
  const waitCreated = isoAtShanghai(waitDate, 10, 0);
  upsertMockTicket(db, {
    id: 'MOCK-E2E-WAIT-URGENT', type: 'repair', cat: '水暖',
    desc: '全流程模拟紧急待派工单', loc: '测试小区-设备层', priority: 'urgent',
    status: 'wait', worker: '', message: '等待主管派单', created: waitCreated,
    finished: '', reject_reason: '', estimated_hours: 1, community_id: MOCK_COMMUNITY.id,
    repeat_key: '', repeat_of: '', repeat_count: 1, is_recurring: 0,
    recurrence_note: '', feedback_count: 1,
    metadata: JSON.stringify({ mock: true, scenario: 'unassigned-flow' }),
    assignee_user_id: null, assigned_at: '', performance_rule_version_id: null,
  });
  upsertMockActivity(db, {
    ticketId: 'MOCK-E2E-WAIT-URGENT', key: 'MOCK-E2E-WAIT-URGENT:create',
    scenario: 'unassigned-flow', actorUserId: Number(supervisor.id),
    actorStaffId: Number(supervisorProfile.id), action: 'create', createdAt: waitCreated,
  });
}

function migrateRetainedTestData(db, rawOptions = {}) {
  const options = requireMigrationOptions(rawOptions);
  ensureRetainedMigrationSchema(db);
  ensureWorkforceSchema(db);
  const planned = planRetainedTestData(db);
  db.run('BEGIN TRANSACTION');
  try {
    const phones = RETAINED_ACCOUNTS.map(account => account.phone);
    const users = upsertRetainedUsers(db, options.password);
    disableOtherUsers(db, phones, options.nowIso, shanghaiDate(options.now));
    const profiles = upsertProfiles(db, users, options.nowIso);
    const supervisorUserId = Number(users.get(phones[0]).id);
    upsertCommunitiesAndMemberships(db, profiles, supervisorUserId, options.nowIso);
    clearAttendanceHistory(db);
    seedMockCalendar(db, profiles, supervisorUserId, options.now, options.nowIso);
    seedMockTickets(db, users, profiles, options.now);
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
    throw error;
  }
  return {
    summary: {
      ...planned.summary,
      mockTickets: Number(one(db,
        "SELECT COUNT(*) AS total FROM tickets WHERE id LIKE 'MOCK-E2E-%'"
      ).total),
      mockAssignments: Number(one(db,
        "SELECT COUNT(*) AS total FROM shift_assignments WHERE note LIKE 'MOCK-E2E%'"
      ).total),
      mockActivities: Number(one(db,
        "SELECT COUNT(*) AS total FROM ticket_activity_logs WHERE ticket_id LIKE 'MOCK-E2E-%'"
      ).total),
    },
  };
}

module.exports = {
  RETAINED_ACCOUNTS,
  MOCK_COMMUNITY,
  planRetainedTestData,
  migrateRetainedTestData,
};
