const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '',
      status TEXT DEFAULT 'wait', priority TEXT DEFAULT 'normal',
      created TEXT NOT NULL, finished TEXT DEFAULT '', estimated_hours REAL DEFAULT 0,
      community_id TEXT DEFAULT 'default', reject_reason TEXT DEFAULT '',
      is_recurring INTEGER DEFAULT 0, feedback_count INTEGER DEFAULT 1
    );
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, password TEXT, role TEXT);
  `);
  ensureWorkforceSchema(db);
  db.run(`
    INSERT INTO staff_profiles (id, user_id, name, manager_id) VALUES
      (1, 1, '主管', NULL), (2, 2, '组长', 1), (3, 3, '师傅', 2), (4, 4, '树外', NULL);
  `);
  return db;
}

test('上海日/月边界和包含结束日的范围使用排他终点', () => {
  const { shanghaiDayRange, shanghaiMonthRange, inclusiveDateRange } = require('../services/reporting');
  assert.deepEqual(shanghaiMonthRange('2026-07-30T12:00:00+08:00'), {
    from: '2026-06-30T16:00:00.000Z',
    toExclusive: '2026-07-31T16:00:00.000Z',
  });
  assert.deepEqual(shanghaiDayRange('2026-07-30'), {
    from: '2026-07-29T16:00:00.000Z',
    toExclusive: '2026-07-30T16:00:00.000Z',
  });
  assert.deepEqual(inclusiveDateRange('2026-07-01', '2026-07-30'), {
    from: '2026-06-30T16:00:00.000Z',
    toExclusive: '2026-07-30T16:00:00.000Z',
  });
  assert.throws(() => inclusiveDateRange('2026-02-30', '2026-03-01'), /日期/);
});

test('人员报告按接单和完成双口径统计，考勤只数现有记录', async () => {
  const db = await fixture();
  db.run(`
    INSERT INTO tickets
      (id, cat, status, created, assigned_at, finished, estimated_hours,
       assignee_user_id, reject_reason, is_recurring, feedback_count)
    VALUES
      ('old-received', '水暖', 'done', '2026-06-10T00:00:00Z', '2026-06-20T00:00:00Z', '2026-07-03T00:00:00Z', 400, 3, '', 0, 1),
      ('received', '电路', 'doing', '2026-07-04T00:00:00Z', '2026-07-05T00:00:00Z', '', 0, 3, '曾退回', 1, 3),
      ('both', '电路', 'done', '2026-07-09T00:00:00Z', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 3, 3, '', 0, 1);
    INSERT INTO attendance_records (staff_id, work_date, status) VALUES
      (3, '2026-07-02', 'normal'), (3, '2026-07-03', 'late');
  `);
  const { getStaffReport } = require('../services/reporting');
  const report = getStaffReport(db, 3, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(report.received.total, 2);
  assert.equal(report.completed.total, 2);
  assert.equal(report.completed.onTimeRate, 100);
  assert.equal(report.attendance.actualDays, 2);
  assert.equal(report.attendance.late, 1);
  assert.deepEqual(report.categories, [{ category: '电路', total: 2 }]);
  assert.equal(report.current.returned, 1);
  assert.equal(report.recurrence.total, 1);
  assert.equal(report.feedback.multiple, 1);
});

test('主管个人动作只计本人，团队成果递归下级且排除树外', async () => {
  const db = await fixture();
  db.run(`
    INSERT INTO tickets
      (id, status, created, assigned_at, finished, estimated_hours, assignee_user_id)
    VALUES
      ('lead-child', 'done', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', 2, 2),
      ('deep-child', 'done', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T01:00:00Z', 2, 3),
      ('outside', 'done', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z', '2026-07-03T01:00:00Z', 2, 4);
    INSERT INTO ticket_activity_logs (ticket_id, actor_staff_id, action, created_at) VALUES
      ('lead-child', 1, 'assign', '2026-07-02T00:00:00Z'),
      ('deep-child', 2, 'assign', '2026-07-02T00:00:00Z');
  `);
  const { getManagerReport } = require('../services/reporting');
  const report = getManagerReport(db, 1, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(report.personalActions.total, 1);
  assert.deepEqual(report.team.staffIds, [2, 3]);
  assert.equal(report.team.completed.total, 2);
});

test('看板本月总量只使用本月创建的工单', async () => {
  const db = await fixture();
  db.run(`
    INSERT INTO tickets (id, type, status, created) VALUES
      ('before', 'repair', 'done', '2026-06-30T15:59:59.999Z'),
      ('first', 'repair', 'wait', '2026-06-30T16:00:00.000Z'),
      ('last', 'complaint', 'done', '2026-07-31T15:59:59.999Z'),
      ('next', 'help', 'wait', '2026-07-31T16:00:00.000Z');
  `);
  const { getDashboardStats } = require('../services/reporting');
  const stats = getDashboardStats(db, { now: '2026-07-30T12:00:00+08:00' });
  assert.equal(stats.monthTotal, 2);
  assert.equal(stats.byType.repair, 1);
  assert.equal(stats.byType.complaint, 1);
});

test('主管首页累计统计从系统最早工单开始计算', async () => {
  const db = await fixture();
  db.run(`
    INSERT INTO tickets (id, type, status, created, assignee_user_id) VALUES
      ('oldest', 'repair', 'done', '2025-01-02T00:00:00Z', 3),
      ('current', 'complaint', 'wait', '2026-07-15T00:00:00Z', 3)
  `);
  const { getDashboardStats } = require('../services/reporting');
  const stats = getDashboardStats(db, {
    now: '2026-08-05T00:00:00+08:00', range: 'all',
  });
  assert.equal(stats.monthTotal, 2);
  assert.equal(stats.range.scope, 'all');
  assert.equal(stats.range.from, '2025-01-01T16:00:00.000Z');
});

test('报告路由要求登录并限制本人或递归团队范围', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const get = async (path, headers) => {
    const response = await fetch(`${server.url}${path}`, { headers });
    return { response, body: await response.json() };
  };
  assert.equal((await get('/api/dashboard/stats')).response.status, 401);
  assert.equal((await get('/api/reports/staff/3', authHeader({ id: 3, role: 'worker' }))).response.status, 200);
  assert.equal((await get('/api/reports/staff/2', authHeader({ id: 3, role: 'worker' }))).response.status, 403);
  assert.equal((await get('/api/reports/staff/3', authHeader({ id: 1, role: 'lead' }))).response.status, 200);
  const attendance = await get('/api/me/attendance?month=2026-07', authHeader({ id: 3, role: 'worker' }));
  assert.equal(attendance.response.status, 200);
  assert.deepEqual(attendance.body.data, []);
});

test('旧 /api/report 匿名无 staff_id 保持兼容，staff_id 分支要求登录', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());

  const legacy = await fetch(`${server.url}/api/report`);
  const legacyBody = await legacy.json();
  assert.equal(legacy.status, 200);
  assert.equal(legacyBody.success, true);
  assert.deepEqual(Object.keys(legacyBody.stats).sort(), ['avgHours', 'done', 'total']);

  const scoped = await fetch(`${server.url}/api/report?staff_id=3`);
  const scopedBody = await scoped.json();
  assert.equal(scoped.status, 401);
  assert.equal(scopedBody.code, 'AUTH_REQUIRED');
});

test('历史完成列参与完成统计，负耗时和无效时间不进入耗时与准时率样本', async (t) => {
  const db = await fixture();
  db.run('ALTER TABLE tickets ADD COLUMN completed_at TEXT DEFAULT ""');
  db.run(`
    INSERT INTO tickets
      (id, status, created, assigned_at, finished, completed_at, estimated_hours, assignee_user_id)
    VALUES
      ('historical', 'done', '2026-07-05T00:00:00Z', '2026-07-05T00:00:00Z', '', '2026-07-05T02:00:00Z', 3, 3),
      ('negative', 'done', '2026-07-06T03:00:00Z', '2026-07-06T03:00:00Z', '2026-07-06T02:00:00Z', '', 10, 3),
      ('bad-start', 'done', '2026-07-07T00:00:00Z', 'not-a-date', '2026-07-07T02:00:00Z', '', 10, 3);
  `);
  const { getStaffReport, getDashboardStats } = require('../services/reporting');
  const report = getStaffReport(db, 3, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(report.completed.total, 3);
  assert.equal(report.completed.averageHours, 2);
  assert.equal(report.completed.onTimeRate, 100);

  const dashboard = getDashboardStats(db, { now: '2026-07-15T00:00:00+08:00' });
  assert.equal(dashboard.averageHours, 2);
  assert.equal(dashboard.onTimeRate, 100);

  const server = await startHttpServer(db);
  t.after(() => server.close());
  const legacy = await fetch(`${server.url}/api/report?from=2026-07-01&to=2026-07-31`);
  assert.equal((await legacy.json()).stats.done, 3);
});

test('主管看板只统计本人递归团队并拒绝跨树社区', async (t) => {
  const db = await fixture();
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO tickets (id, status, created, community_id, assignee_user_id) VALUES
      ('own-tree', 'wait', ?, 'team-a', 1),
      ('deep-tree', 'wait', ?, 'team-a', 3),
      ('other-tree', 'wait', ?, 'team-b', 4)
  `, [now, now, now]);
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const leadOne = authHeader({ id: 1, role: 'lead' });
  const leadFour = authHeader({ id: 4, role: 'lead' });

  const own = await fetch(`${server.url}/api/dashboard/stats`, { headers: leadOne });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).data.monthTotal, 2);

  const other = await fetch(`${server.url}/api/dashboard/stats`, { headers: leadFour });
  assert.equal(other.status, 200);
  assert.equal((await other.json()).data.monthTotal, 1);

  const forbidden = await fetch(`${server.url}/api/dashboard/stats?community_id=team-b`, {
    headers: leadOne,
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, 'REPORT_SCOPE_FORBIDDEN');
});

test('报告路由对未知数据库异常返回通用 500 且不回显 SQL', async (t) => {
  const db = await fixture();
  db.run('DROP TABLE tickets');
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const headers = authHeader({ id: 3, role: 'worker' });

  for (const path of ['/api/reports/staff/3', '/api/report?staff_id=3']) {
    const response = await fetch(`${server.url}${path}`, { headers });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.error, '服务器内部错误');
    assert.doesNotMatch(JSON.stringify(body), /tickets|SQL|no such/i);
  }
});
