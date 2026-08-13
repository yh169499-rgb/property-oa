const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { RETAINED_ACCOUNTS, MOCK_COMMUNITY } = require('../services/retained-test-data');
const { detectCalendarConflicts } = require('../services/calendar');
const { getAllStaffReport } = require('../services/reporting');

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

function problem(problems, code, message) {
  problems.push({ code, message });
}

function inspectDatabase(db, password) {
  const problems = [];
  const phones = RETAINED_ACCOUNTS.map(account => account.phone);
  const expected = new Map(RETAINED_ACCOUNTS.map(account => [account.phone, account]));
  const activeUsers = rows(db, "SELECT id, phone, name, role, password FROM users WHERE status = 'active' ORDER BY phone");
  if (activeUsers.length !== 5 || activeUsers.some(user => !expected.has(String(user.phone)))) {
    problem(problems, 'UNEXPECTED_ACTIVE_ACCOUNT', 'active 账号必须恰好为固定 5 个');
  }
  let loginVerified = 0;
  for (const account of RETAINED_ACCOUNTS) {
    const user = activeUsers.find(row => String(row.phone) === account.phone);
    if (!user || user.role !== account.role || user.name !== account.name) {
      problem(problems, 'RETAINED_ACCOUNT_MISMATCH', `账号 ${account.phone} 的姓名、角色或状态不正确`);
      continue;
    }
    if (bcrypt.compareSync(password, String(user.password || ''))) loginVerified += 1;
    else problem(problems, 'LOGIN_PASSWORD_MISMATCH', `账号 ${account.phone} 无法使用运行时测试密码验证`);
  }
  const unexpectedEnabled = Number(one(db,
    `SELECT COUNT(*) AS total FROM users
     WHERE phone NOT IN (${phones.map(() => '?').join(', ')}) AND status <> 'disabled'`,
    phones
  ).total);
  if (unexpectedEnabled) problem(problems, 'UNEXPECTED_ACTIVE_ACCOUNT', '存在未停用的非保留账号');

  const profiles = rows(db, `SELECT u.phone, sp.id, sp.manager_id, sp.employment_status
    FROM users u JOIN staff_profiles sp ON sp.user_id = u.id
    WHERE u.phone IN (${phones.map(() => '?').join(', ')}) ORDER BY u.phone`, phones);
  if (profiles.length !== 5 || profiles.some(profile => profile.employment_status !== 'active')) {
    problem(problems, 'PROFILE_SCOPE_MISMATCH', '保留账号的 active 档案不完整');
  }
  const activeProfiles = Number(one(db,
    "SELECT COUNT(*) AS total FROM staff_profiles WHERE COALESCE(employment_status, 'active') = 'active'"
  ).total);
  if (activeProfiles !== 5) {
    problem(problems, 'UNEXPECTED_ACTIVE_PROFILE', 'active 人员档案必须恰好为固定 5 人');
  }
  const supervisor = profiles.find(profile => profile.phone === '13800000001');
  const managedBySupervisor = supervisor
    ? profiles.filter(profile => profile.phone !== '13800000001'
      && Number(profile.manager_id) === Number(supervisor.id)).length
    : 0;
  if (!supervisor || supervisor.manager_id != null || managedBySupervisor !== 4) {
    problem(problems, 'ORGANIZATION_MISMATCH', '主管层级不是一个主管管理四名员工');
  }
  const defaultMemberships = Number(one(db, `SELECT COUNT(*) AS total
    FROM community_memberships cm JOIN staff_profiles sp ON sp.id = cm.staff_profile_id
    JOIN users u ON u.id = sp.user_id
    WHERE cm.community_id = 'default' AND u.phone IN (${phones.map(() => '?').join(', ')})`, phones).total);
  const mockMemberships = Number(one(db, `SELECT COUNT(*) AS total
    FROM community_memberships WHERE community_id = ?`, [MOCK_COMMUNITY.id]).total);
  if (defaultMemberships !== 5 || mockMemberships < 3) {
    problem(problems, 'COMMUNITY_SCOPE_MISMATCH', '固定账号的小区成员关系不完整');
  }

  const calendarCounts = one(db, `SELECT
    (SELECT COUNT(*) FROM shift_templates WHERE name IN ('模拟白班', '模拟夜班')) AS templates,
    (SELECT COUNT(*) FROM shift_assignments WHERE note LIKE 'MOCK-E2E%') AS assignments,
    (SELECT COUNT(*) FROM shift_assignments WHERE note LIKE 'MOCK-E2E%' AND assignment_type = 'leave') AS leave,
    (SELECT COUNT(*) FROM shift_assignments WHERE note = 'MOCK-E2E-OVERNIGHT'
      AND julianday(end_at) > julianday(start_at)) AS overnight,
    (SELECT COUNT(*) FROM attendance_records) AS attendance`);
  const conflictRows = rows(db, `SELECT t.id, sp.id AS staff_id, t.assigned_at, t.created, t.estimated_hours
    FROM tickets t JOIN staff_profiles sp ON sp.user_id = t.assignee_user_id
    WHERE t.id IN ('MOCK-E2E-02-CURRENT', 'MOCK-E2E-02-CONFLICT')`);
  const ticketConflicts = detectCalendarConflicts(conflictRows.map(ticket => {
    const startAt = ticket.assigned_at || ticket.created;
    return {
      ticketId: ticket.id,
      staffId: Number(ticket.staff_id),
      startAt,
      endAt: new Date(Date.parse(startAt) + Number(ticket.estimated_hours) * 3600000).toISOString(),
    };
  })).length;
  const calendar = {
    templates: Number(calendarCounts.templates),
    assignments: Number(calendarCounts.assignments),
    leave: Number(calendarCounts.leave),
    overnight: Number(calendarCounts.overnight),
    attendance: Number(calendarCounts.attendance),
    ticketConflicts,
  };
  if (calendar.templates !== 2 || calendar.assignments < 12 || calendar.leave < 1
      || calendar.overnight < 1 || calendar.attendance !== 0 || calendar.ticketConflicts < 1) {
    problem(problems, 'CALENDAR_SCENARIO_MISSING', '白班、跨夜班、请假、零考勤或工单冲突场景不完整');
  }

  const completedRows = rows(db, `SELECT u.phone,
    SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN t.status <> 'done' THEN 1 ELSE 0 END) AS current_count
    FROM users u LEFT JOIN tickets t ON t.assignee_user_id = u.id AND t.id LIKE 'MOCK-E2E-%'
    WHERE u.phone IN ('13800000002', '13800000003', '13800000004', '13800000006')
    GROUP BY u.phone ORDER BY u.phone`);
  const completedPerPerson = completedRows.map(row => Number(row.completed || 0));
  const currentPerPerson = completedRows.map(row => Number(row.current_count || 0));
  if (completedRows.length !== 4 || completedPerPerson.some(count => count < 5)
      || currentPerPerson.some(count => count < 1)) {
    problem(problems, 'INSUFFICIENT_PERFORMANCE_SAMPLE', '每名普通测试人员必须有至少五张完成工单和一张当前工单');
  }
  const statuses = new Set(rows(db,
    "SELECT DISTINCT status FROM tickets WHERE id LIKE 'MOCK-E2E-%'"
  ).map(row => row.status));
  if (!['wait', 'doing', 'pending', 'confirm', 'done'].every(status => statuses.has(status))) {
    problem(problems, 'WORKFLOW_COVERAGE_MISSING', '模拟工单状态覆盖不完整');
  }
  const featureCounts = one(db, `SELECT
    SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) AS urgent,
    SUM(CASE WHEN is_recurring = 1 THEN 1 ELSE 0 END) AS recurring,
    SUM(CASE WHEN feedback_count > 1 THEN 1 ELSE 0 END) AS multi_feedback,
    SUM(CASE WHEN community_id = ? THEN 1 ELSE 0 END) AS multi_community,
    SUM(CASE WHEN assignee_user_id IS NOT NULL AND performance_rule_version_id IS NULL THEN 1 ELSE 0 END) AS missing_rule
    FROM tickets WHERE id LIKE 'MOCK-E2E-%'`, [MOCK_COMMUNITY.id]);
  if (!featureCounts || Number(featureCounts.urgent) < 1 || Number(featureCounts.recurring) < 1
      || Number(featureCounts.multi_feedback) < 1 || Number(featureCounts.multi_community) < 1
      || Number(featureCounts.missing_rule) > 0) {
    problem(problems, 'WORKFLOW_FEATURE_MISSING', '紧急、复发、多人反馈、多小区或绩效版本样本不完整');
  }
  const activityCount = Number(one(db,
    "SELECT COUNT(*) AS total FROM ticket_activity_logs WHERE ticket_id LIKE 'MOCK-E2E-%'"
  ).total);
  if (activityCount < 60) problem(problems, 'ACTIVITY_FLOW_MISSING', '工单活动链数量不足');

  let reporting = { activeStaff: 0, scoredStaff: 0 };
  try {
    const mockRange = one(db, `SELECT
      MIN(substr(datetime(created, '+8 hours'), 1, 10)) AS from_date,
      MAX(substr(datetime(COALESCE(NULLIF(finished, ''), created), '+8 hours'), 1, 10)) AS to_date
      FROM tickets WHERE id LIKE 'MOCK-E2E-%'`);
    const report = getAllStaffReport(db, {
      from: mockRange.from_date,
      to: mockRange.to_date,
    }, profiles.map(profile => Number(profile.id)));
    reporting = {
      activeStaff: Array.isArray(report.staffReports) ? report.staffReports.length : 0,
      scoredStaff: Array.isArray(report.staffReports)
        ? report.staffReports.filter(item => item.staff.id !== Number(supervisor?.id)
          && item.performance?.status === 'scored'
          && Number.isFinite(Number(item.performance?.score))).length
        : 0,
    };
  } catch (_) {
    problem(problems, 'REPORT_GENERATION_FAILED', '服务端全员报告生成失败');
  }
  if (reporting.activeStaff !== 5 || reporting.scoredStaff !== 4) {
    problem(problems, 'REPORT_SAMPLE_MISSING', '全员报告或普通人员绩效样本不完整');
  }

  return {
    ok: problems.length === 0,
    accounts: { active: activeUsers.length, loginVerified },
    organization: {
      profiles: profiles.length, activeProfiles, managedBySupervisor,
      defaultMemberships, mockMemberships,
    },
    calendar,
    mockTickets: { completedPerPerson, currentPerPerson, activityCount },
    reporting,
    problems,
  };
}

async function verifyRetainedTestData(options = {}) {
  if (!options.password) throw new Error('缺少 RETAINED_TEST_PASSWORD');
  if (!options.source || !path.isAbsolute(options.source)) throw new Error('source 必须是绝对路径');
  if (!fs.existsSync(options.source)) throw new Error('source 数据库文件不存在');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(options.source));
  try {
    return inspectDatabase(db, options.password);
  } finally {
    db.close();
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const argument of argv) {
    if (argument.startsWith('--source=')) values.source = argument.slice('--source='.length);
    else if (argument === '--help') values.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return values;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('用法：RETAINED_TEST_PASSWORD=<运行时输入> node scripts/verify-retained-test-data.js --source=/absolute/path/data.db');
    return;
  }
  const result = await verifyRetainedTestData({
    ...args, password: process.env.RETAINED_TEST_PASSWORD || '',
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { inspectDatabase, verifyRetainedTestData, parseArgs };
