const database = require('../db');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { resolveShiftWindow } = require('../services/shifts');

const DEMO_PHONES = {
  lead: '13800000011',
  worker: '13800000012',
  keeper: '13800000013',
};

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function one(db, sql, params = []) { return rows(db, sql, params)[0] || null; }

function localDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function isoAt(date, hour, minute = 0) {
  const value = new Date(date.getTime());
  value.setUTCHours(hour - 8, minute, 0, 0);
  return value.toISOString();
}

function upsertTemplate(db, value, userId, inserted) {
  const current = one(db, 'SELECT id FROM shift_templates WHERE name = ?', [value.name]);
  if (current) return Number(current.id);
  db.run(
    `INSERT INTO shift_templates (name, start_time, end_time, color, grace_minutes, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [value.name, value.startTime, value.endTime, value.color, value.graceMinutes, userId]
  );
  inserted.templates += 1;
  return Number(one(db, 'SELECT id FROM shift_templates WHERE id = last_insert_rowid()').id);
}

function upsertAssignment(db, value, userId, inserted) {
  const current = one(db, 'SELECT id FROM shift_assignments WHERE staff_id = ? AND work_date = ?', [value.staffId, value.workDate]);
  if (current) return Number(current.id);
  const window = value.templateId ? resolveShiftWindow(value.workDate, value.startTime, value.endTime) : { startAt: null, endAt: null };
  db.run(
    `INSERT INTO shift_assignments
      (staff_id, work_date, assignment_type, template_id, start_at, end_at, leave_type, note, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [value.staffId, value.workDate, value.assignmentType, value.templateId, window.startAt, window.endAt,
      value.leaveType || null, value.note || '', userId, new Date().toISOString()]
  );
  inserted.assignments += 1;
  return Number(one(db, 'SELECT id FROM shift_assignments WHERE id = last_insert_rowid()').id);
}

function upsertAttendance(db, value, inserted) {
  if (one(db, 'SELECT id FROM attendance_records WHERE staff_id = ? AND work_date = ?', [value.staffId, value.workDate])) return;
  db.run(
    `INSERT INTO attendance_records
      (staff_id, shift_assignment_id, work_date, check_in_at, check_out_at, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [value.staffId, value.shiftAssignmentId, value.workDate, value.checkInAt || null,
      value.checkOutAt || null, value.status, new Date().toISOString()]
  );
  inserted.attendance += 1;
}

function upsertTicket(db, ticket, inserted) {
  if (one(db, 'SELECT id FROM tickets WHERE id = ?', [ticket.id])) return;
  db.run(
    `INSERT INTO tickets
      (id, type, cat, desc, loc, priority, status, worker, message, created, finished,
       estimated_hours, community_id, assignee_user_id, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ticket.id, 'repair', ticket.category, ticket.description, ticket.location, ticket.priority,
      ticket.status, ticket.worker, ticket.description, ticket.created, ticket.finished || '',
      ticket.estimatedHours, 'default', ticket.assigneeUserId, ticket.assignedAt]
  );
  inserted.tickets += 1;
}

function seedDemo(db, now = new Date()) {
  ensureWorkforceSchema(db);
  const inserted = { profiles: 0, templates: 0, assignments: 0, attendance: 0, tickets: 0 };
  const users = {};
  Object.entries(DEMO_PHONES).forEach(([key, phone]) => {
    const user = one(db, 'SELECT id, name, role FROM users WHERE phone = ?', [phone]);
    if (user) users[key] = user;
  });
  if (!users.lead || !users.worker || !users.keeper) {
    throw new Error('请先创建测试账号 13800000011、13800000012、13800000013，再运行模拟数据种子');
  }

  const staff = {};
  const staffValues = [
    ['lead', '测试主管', '主管', null], ['worker', '测试师傅', '维修师傅', null], ['keeper', '测试管家', '物业管家', null],
  ];
  staffValues.forEach(([key, name, position, managerId]) => {
    let profile = one(db, 'SELECT id FROM staff_profiles WHERE user_id = ?', [users[key].id]);
    if (!profile) {
      db.run(
        `INSERT INTO staff_profiles (user_id, name, position, join_date, employment_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [users[key].id, name, position, localDate(now), new Date().toISOString(), new Date().toISOString()]
      );
      profile = one(db, 'SELECT id FROM staff_profiles WHERE user_id = ?', [users[key].id]);
      inserted.profiles += 1;
    }
    staff[key] = Number(profile.id);
  });
  db.run('UPDATE staff_profiles SET manager_id = ? WHERE id IN (?, ?)', [staff.lead, staff.worker, staff.keeper]);

  const standardId = upsertTemplate(db, { name: '演示标准白班', startTime: '08:00', endTime: '18:00', color: '#2f6fed', graceMinutes: 5 }, users.lead.id, inserted);
  const nightId = upsertTemplate(db, { name: '演示晚班', startTime: '22:00', endTime: '06:00', color: '#7c5ce5', graceMinutes: 10 }, users.lead.id, inserted);
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(now.getTime() - offset * 86400000);
    const workDate = localDate(day);
    const workerAssignment = upsertAssignment(db, {
      staffId: staff.worker, workDate, assignmentType: 'work', templateId: standardId,
      startTime: '08:00', endTime: '18:00', note: '演示排班'
    }, users.lead.id, inserted);
    upsertAttendance(db, {
      staffId: staff.worker, shiftAssignmentId: workerAssignment, workDate,
      checkInAt: isoAt(day, offset === 1 ? 8 : 7, offset === 1 ? 12 : 58),
      checkOutAt: isoAt(day, 18, 4), status: offset === 1 ? 'late' : 'normal'
    }, inserted);
    const keeperAssignment = upsertAssignment(db, {
      staffId: staff.keeper, workDate, assignmentType: offset === 2 ? 'leave' : 'work',
      templateId: offset === 2 ? null : standardId, startTime: '08:00', endTime: '18:00',
      leaveType: offset === 2 ? '事假' : null, note: '演示排班'
    }, users.lead.id, inserted);
    if (offset !== 2) upsertAttendance(db, {
      staffId: staff.keeper, shiftAssignmentId: keeperAssignment, workDate,
      checkInAt: isoAt(day, 7, 55), checkOutAt: isoAt(day, 18, 2), status: 'normal'
    }, inserted);
  }
  const overnightDate = localDate(new Date(now.getTime() - 86400000));
  upsertAssignment(db, {
    staffId: staff.lead, workDate: overnightDate, assignmentType: 'work', templateId: nightId,
    startTime: '22:00', endTime: '06:00', note: '演示跨夜班'
  }, users.lead.id, inserted);

  const ticketDate = new Date(now.getTime() - 86400000);
  const created = isoAt(ticketDate, 9, 0);
  const assigned = isoAt(ticketDate, 9, 10);
  [
    ['DEMO-WF-001', '水暖', '处理中漏水', '1栋-101', 'doing', users.worker.id, '测试师傅', 2, assigned, ''],
    ['DEMO-WF-002', '电路', '走廊灯不亮', '2栋-201', 'doing', users.worker.id, '测试师傅', 1, isoAt(ticketDate, 9, 40), ''],
    ['DEMO-WF-003', '门窗', '门锁卡顿', '3栋-301', 'done', users.worker.id, '测试师傅', 1, isoAt(ticketDate, 11, 0), isoAt(ticketDate, 13, 0)],
    ['DEMO-WF-004', '公共设施', '电梯按钮故障', '4栋-大厅', 'confirm', users.keeper.id, '测试管家', 2, isoAt(ticketDate, 10, 0), ''],
    ['DEMO-WF-005', '水暖', '水压偏低', '5栋-501', 'wait', null, '', 1, '', ''],
    ['DEMO-WF-006', '电器', '空调异响', '6栋-601', 'done', users.keeper.id, '测试管家', 1, isoAt(ticketDate, 14, 0), isoAt(ticketDate, 16, 0)],
  ].forEach(([id, category, description, location, status, assigneeUserId, worker, estimatedHours, assignedAt, finished]) => {
    upsertTicket(db, { id, category, description, location, status, assigneeUserId, worker, estimatedHours,
      created, assignedAt: assignedAt || created, finished, priority: id === 'DEMO-WF-005' ? 'urgent' : 'normal' }, inserted);
  });
  return { inserted };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('用法：SEED_WORKFORCE_DEMO=true DB_PATH=/path/to/data.db node scripts/seed-workforce-demo.js');
    return;
  }
  if (process.env.SEED_WORKFORCE_DEMO !== 'true') {
    console.error('为保护数据库，必须显式设置 SEED_WORKFORCE_DEMO=true');
    process.exitCode = 1;
    return;
  }
  await database.initDB();
  const result = seedDemo(database.getDB());
  database.saveDB();
  console.log('模拟数据种子完成：', JSON.stringify(result.inserted));
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { DEMO_PHONES, seedDemo };
