const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const config = require('../config');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');
const { canAccessTicket } = require('../routes/tickets');

const SUPERVISOR = { id: 1, role: '主管', name: '主管' };
const WORKER_A = { id: 2, role: 'worker', name: '同名师傅' };
const WORKER_B = { id: 3, role: 'worker', name: '同名师傅' };
const KEEPER = { id: 4, role: 'keeper', name: '管家' };
const OTHER_ROLE = { id: 7, role: 'guest', name: '观察员' };

async function patchTicket(server, id, user, body) {
  return request(server, `/api/tickets/${id}`, user, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function fixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, phone TEXT UNIQUE, password TEXT,
      name TEXT, role TEXT, status TEXT DEFAULT 'active'
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, type TEXT DEFAULT 'repair', cat TEXT DEFAULT '其他',
      desc TEXT DEFAULT '', loc TEXT DEFAULT '', priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'wait', worker TEXT DEFAULT '', message TEXT DEFAULT '',
      created TEXT NOT NULL, finished TEXT DEFAULT '', reject_reason TEXT DEFAULT '',
      estimated_hours REAL DEFAULT 0, session_id TEXT DEFAULT '',
      community_id TEXT DEFAULT 'default', repeat_key TEXT DEFAULT '', repeat_of TEXT DEFAULT '',
      repeat_count INTEGER DEFAULT 1, is_recurring INTEGER DEFAULT 0,
      recurrence_note TEXT DEFAULT '', feedback_count INTEGER DEFAULT 1, metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE communities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '', created TEXT NOT NULL
    );
  `);
  ensureWorkforceSchema(db);
  db.run(`INSERT INTO users (id, phone, password, name, role) VALUES
    (1, '13800000001', 'x', '主管', '主管'),
    (2, '13800000002', 'x', '同名师傅', 'worker'),
    (3, '13800000003', 'x', '同名师傅', 'worker'),
    (4, '13800000004', 'x', '管家', 'keeper'),
    (5, '13800000005', 'x', '离职师傅', 'worker'),
    (6, '13800000006', 'x', '外部师傅', 'worker'),
    (7, '13800000007', 'x', '观察员', 'guest')
  `);
  db.run(`INSERT INTO communities (id, name, created) VALUES
    ('c1', '一号小区', '2026-01-01T00:00:00.000Z'),
    ('c2', '二号小区', '2026-01-01T00:00:00.000Z')
  `);
  db.run(`INSERT INTO staff_profiles
    (id, user_id, name, position, employment_status, created_at, updated_at) VALUES
    (1, 1, '主管', '主管', 'active', '2026-01-01', '2026-01-01'),
    (2, 2, '同名师傅', '维修师傅', 'active', '2026-01-01', '2026-01-01'),
    (3, 3, '同名师傅', '维修师傅', 'active', '2026-01-01', '2026-01-01'),
    (4, 4, '管家', '物业管家', 'active', '2026-01-01', '2026-01-01'),
    (5, 5, '离职师傅', '维修师傅', 'departed', '2026-01-01', '2026-01-01'),
    (6, 6, '外部师傅', '维修师傅', 'active', '2026-01-01', '2026-01-01'),
    (7, 7, '观察员', '观察员', 'active', '2026-01-01', '2026-01-01')
  `);
  db.run('UPDATE staff_profiles SET manager_id = 1 WHERE id IN (2, 3, 4, 5, 7)');
  db.run(`INSERT INTO community_memberships (community_id, staff_profile_id, created_at) VALUES
    ('c1', 1, '2026-01-01'), ('c1', 2, '2026-01-01'),
    ('c1', 3, '2026-01-01'), ('c1', 4, '2026-01-01')
  `);
  const tickets = [
    ['R-A', 'repair', 'c1', 2, '同名师傅'],
    ['C-A', 'complaint', 'c1', 2, '同名师傅'],
    ['H-A', 'help', 'c2', 2, '同名师傅'],
    ['R-B', 'repair', 'c1', 3, '同名师傅'],
    ['C-B', 'complaint', 'c1', 3, '同名师傅'],
    ['H-B', 'help', 'c1', 3, '同名师傅'],
    ['K-R', 'repair', 'c1', 4, '管家'],
    ['K-C', 'complaint', 'c1', 4, '管家'],
    ['K-A', 'help', 'c1', 4, '管家'],
    ['LEGACY-SAME', 'complaint', 'c1', null, '同名师傅'],
    ['UNASSIGNED', 'repair', 'c1', null, ''],
    ['GUEST-A', 'repair', 'c1', 7, '观察员'],
    ['UNKNOWN-A', 'inspection', 'c1', 2, '同名师傅'],
  ];
  for (const [id, type, communityId, assigneeUserId, worker] of tickets) {
    db.run(`INSERT INTO tickets
      (id, type, community_id, assignee_user_id, worker, created)
      VALUES (?, ?, ?, ?, ?, '2026-08-01T00:00:00.000Z')`,
    [id, type, communityId, assigneeUserId, worker]);
  }
  return db;
}

async function request(server, path, user, options = {}) {
  const response = await fetch(`${server.url}${path}`, {
    ...options,
    headers: { ...authHeader(user), ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

test('普通员工列表仅返回当前账号被派发的三类工单', async (t) => {
  const server = await startHttpServer(await fixture());
  t.after(() => server.close());

  const mine = await request(server, '/api/tickets', WORKER_A);
  assert.equal(mine.response.status, 200);
  assert.deepEqual(mine.body.data.map((ticket) => ticket.id).sort(), ['C-A', 'H-A', 'R-A']);

  const otherWorker = await request(server, '/api/tickets', WORKER_B);
  assert.deepEqual(otherWorker.body.data.map((ticket) => ticket.id).sort(), ['C-B', 'H-B', 'R-B']);

  const keeper = await request(server, '/api/tickets', KEEPER);
  assert.deepEqual(keeper.body.data.map((ticket) => ticket.id).sort(), ['K-A', 'K-C', 'K-R']);
});

test('普通员工即使是本人负责也不能读取或操作未知类型工单', async (t) => {
  const server = await startHttpServer(await fixture());
  t.after(() => server.close());

  const list = await request(server, '/api/tickets', WORKER_A);
  assert.equal(list.body.data.some((ticket) => ticket.id === 'UNKNOWN-A'), false);
  assert.equal((await request(server, '/api/tickets/UNKNOWN-A', WORKER_A)).response.status, 404);
  const mutation = await patchTicket(server, 'UNKNOWN-A', WORKER_A, { status: 'doing' });
  assert.equal(mutation.response.status, 403);
  assert.equal(mutation.body.code, 'TICKET_SCOPE_FORBIDDEN');

  const supervisor = await request(server, '/api/tickets/UNKNOWN-A', SUPERVISOR);
  assert.equal(supervisor.response.status, 200);
});

test('普通员工创建工单时由服务端强制初始状态、优先级、时间和未派单身份', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());
  const startedAt = Date.now();

  const created = await request(server, '/api/tickets', WORKER_A, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'INJECTED-ID', type: 'complaint', cat: '噪音', desc: '深夜噪音',
      loc: '一号楼-999', message: '请处理', community_id: 'c1',
      worker: '管家', status: 'done', priority: 'urgent',
      created: '2000-01-01T00:00:00.000Z', finished: '2000-01-01T01:00:00.000Z',
      assignee_user_id: 4, assignee_staff_profile_id: 4, estimated_hours: 99,
    }),
  });
  assert.equal(created.response.status, 200);
  assert.notEqual(created.body.record.id, 'INJECTED-ID');
  const row = db.exec(`SELECT type, cat, desc, loc, message, community_id,
    status, priority, worker, assignee_user_id, assignee_staff_profile_id,
    finished, estimated_hours, created
    FROM tickets WHERE id = ?`, [created.body.record.id])[0].values[0];
  assert.deepEqual(row.slice(0, 6), ['complaint', '噪音', '深夜噪音', '一号楼-999', '请处理', 'c1']);
  assert.deepEqual(row.slice(6, 13), ['wait', 'normal', '', null, null, '', 0]);
  assert.ok(Date.parse(row[13]) >= startedAt);
});

test('创建拒绝未知工单类型，主管创建处理中工单必须稳定派单', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());

  const unknown = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'inspection', community_id: 'c1', loc: '未知类型' }),
  });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.code, 'INVALID_TICKET_TYPE');

  const unassignedDoing = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'repair', status: 'doing', community_id: 'c1', loc: '无人派单' }),
  });
  assert.equal(unassignedDoing.response.status, 400);
  assert.equal(unassignedDoing.body.code, 'INVALID_TICKET_INITIAL_STATE');

  const assigned = await request(server, '/api/tickets', SUPERVISOR, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'SUPERVISOR-CREATE', type: 'help', status: 'doing', worker: '管家',
      priority: 'high', community_id: 'c1', loc: '主管派单',
    }),
  });
  assert.equal(assigned.response.status, 200);
  assert.deepEqual(
    db.exec(`SELECT status, priority, worker, assignee_user_id,
      assignee_staff_profile_id, assigned_at <> '' FROM tickets WHERE id = 'SUPERVISOR-CREATE'`)[0].values[0],
    ['doing', 'high', '管家', 4, 4, 1]
  );
});

test('旧 tickets 表缺少派单身份列时普通员工快速拒绝、主管仍可全局访问', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE tickets (id TEXT PRIMARY KEY, community_id TEXT)');
  db.run("INSERT INTO tickets (id, community_id) VALUES ('LEGACY', 'default')");
  const restoreDB = require('../db').setDBForTests(db);
  try {
    assert.equal(canAccessTicket({ user: WORKER_A }, 'LEGACY'), false);
    assert.equal(canAccessTicket({ user: SUPERVISOR }, 'LEGACY'), true);
  } finally {
    restoreDB();
  }
});

test('查询参数只缩小普通员工账号范围，不能通过同名或小区扩大范围', async (t) => {
  const server = await startHttpServer(await fixture());
  t.after(() => server.close());

  const filtered = await request(
    server,
    `/api/tickets?type=complaint&worker=${encodeURIComponent('同名师傅')}&community_id=c1`,
    WORKER_A
  );
  assert.equal(filtered.response.status, 200);
  assert.deepEqual(filtered.body.data.map((ticket) => ticket.id), ['C-A']);

  const otherByCommunity = await request(server, '/api/tickets?community_id=c1', WORKER_A);
  assert.deepEqual(otherByCommunity.body.data.map((ticket) => ticket.id).sort(), ['C-A', 'R-A']);
});

test('普通员工读取他人工单详情、附件列表和上传统一返回 404', async (t) => {
  const server = await startHttpServer(await fixture());
  t.after(() => server.close());

  for (const path of ['/api/tickets/R-B', '/api/tickets/R-B/photos']) {
    const result = await request(server, path, WORKER_A);
    assert.equal(result.response.status, 404, path);
  }
  const upload = await request(server, '/api/tickets/R-B/photos', WORKER_A, { method: 'POST' });
  assert.equal(upload.response.status, 404);
});

test('普通员工可上传并下载本人工单附件，他人访问原始附件返回 404', async (t) => {
  const originalUploadDir = config.UPLOAD_DIR;
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-oa-ticket-upload-'));
  config.UPLOAD_DIR = uploadDir;
  t.after(() => {
    config.UPLOAD_DIR = originalUploadDir;
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });
  const server = await startHttpServer(await fixture());
  t.after(() => server.close());

  const form = new FormData();
  form.append('photos', new Blob(['image-bytes'], { type: 'image/png' }), 'proof.png');
  const uploaded = await fetch(`${server.url}/api/tickets/R-A/photos`, {
    method: 'POST', headers: authHeader(WORKER_A), body: form,
  });
  assert.equal(uploaded.status, 200);
  const uploadBody = await uploaded.json();
  assert.equal(uploadBody.uploaded, 1);
  const attachmentUrl = uploadBody.photos[0].url;

  const ownDownload = await fetch(`${server.url}${attachmentUrl}`, {
    headers: authHeader(WORKER_A),
  });
  assert.equal(ownDownload.status, 200);
  assert.equal(await ownDownload.text(), 'image-bytes');

  const otherDownload = await fetch(`${server.url}${attachmentUrl}`, {
    headers: authHeader(WORKER_B),
  });
  assert.equal(otherDownload.status, 404);
});

test('主管保留工单全局读取和查询筛选能力', async (t) => {
  const server = await startHttpServer(await fixture());
  t.after(() => server.close());

  const filtered = await request(server, '/api/tickets?type=help&community_id=c1', SUPERVISOR);
  assert.equal(filtered.response.status, 200);
  assert.deepEqual(filtered.body.data.map((ticket) => ticket.id).sort(), ['H-B', 'K-A']);

  const detail = await request(server, '/api/tickets/R-B', SUPERVISOR);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.id, 'R-B');
});

test('维修师傅和管家均可处理本人的三类工单但不能直接完成', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());

  for (const [user, ids] of [
    [WORKER_A, ['R-A', 'C-A', 'H-A']],
    [KEEPER, ['K-R', 'K-C', 'K-A']],
  ]) {
    for (const id of ids) {
      assert.equal((await patchTicket(server, id, user, { status: 'doing' })).response.status, 200, `${id}:start`);
      assert.equal((await patchTicket(server, id, user, { status: 'pending' })).response.status, 200, `${id}:suspend`);
      assert.equal((await patchTicket(server, id, user, { status: 'doing' })).response.status, 200, `${id}:resume`);
      assert.equal((await patchTicket(server, id, user, { status: 'wait' })).response.status, 200, `${id}:return`);
      assert.equal((await patchTicket(server, id, user, { status: 'doing' })).response.status, 200, `${id}:restart`);
      assert.equal((await patchTicket(server, id, user, { status: 'confirm' })).response.status, 200, `${id}:submit`);
      const done = await patchTicket(server, id, user, { status: 'done', finished: '2026-08-12T12:00:00.000Z' });
      assert.equal(done.response.status, 403, `${id}:done`);
      assert.equal(done.body.code, 'TICKET_SCOPE_FORBIDDEN');
    }
  }
  assert.deepEqual(
    db.exec(`SELECT DISTINCT actor_user_id, actor_staff_id
      FROM ticket_activity_logs ORDER BY actor_user_id`)[0].values,
    [[2, 2], [4, 4]]
  );
});

test('普通员工操作他人工单返回 403，非法状态转换返回稳定 400', async (t) => {
  const server = await startHttpServer(await fixture());
  t.after(() => server.close());

  for (const id of ['R-B', 'C-B', 'H-B']) {
    const other = await patchTicket(server, id, WORKER_A, { status: 'doing' });
    assert.equal(other.response.status, 403, id);
    assert.equal(other.body.code, 'TICKET_SCOPE_FORBIDDEN');
  }
  const invalid = await patchTicket(server, 'R-A', WORKER_A, { status: 'confirm' });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.code, 'INVALID_TICKET_TRANSITION');

  const wrongRole = await patchTicket(server, 'GUEST-A', OTHER_ROLE, { status: 'doing' });
  assert.equal(wrongRole.response.status, 403);
  assert.equal(wrongRole.body.code, 'TICKET_SCOPE_FORBIDDEN');
});

test('普通员工不能修改主管字段', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());

  const forbiddenPatches = [
    { worker: '管家' },
    { assignee_user_id: 4 },
    { assigneeStaffProfileId: 4 },
    { community_id: 'c2' },
    { communityId: 'c2' },
    { priority: 'urgent' },
    { finished: '2026-08-12T12:00:00.000Z' },
    { performance_rule_version_id: 999 },
    { cat: '篡改分类' },
  ];
  for (const patch of forbiddenPatches) {
    const result = await patchTicket(server, 'R-A', WORKER_A, patch);
    assert.equal(result.response.status, 403, JSON.stringify(patch));
    assert.equal(result.body.code, 'TICKET_SCOPE_FORBIDDEN');
  }
  const row = db.exec("SELECT worker, community_id, priority, finished, cat FROM tickets WHERE id = 'R-A'")[0].values[0];
  assert.deepEqual(row, ['同名师傅', 'c1', 'normal', '', '其他']);
});

test('只有主管可稳定派单并最终完成，重名或非在职直属人员拒绝派单', async (t) => {
  const db = await fixture();
  const server = await startHttpServer(db);
  t.after(() => server.close());

  const ambiguous = await patchTicket(server, 'UNASSIGNED', SUPERVISOR, { worker: '同名师傅', status: 'doing' });
  assert.equal(ambiguous.response.status, 409);
  assert.equal(ambiguous.body.code, 'ASSIGNEE_NOT_ELIGIBLE');
  for (const worker of ['离职师傅', '外部师傅']) {
    const rejected = await patchTicket(server, 'UNASSIGNED', SUPERVISOR, { worker });
    assert.equal(rejected.response.status, 409, worker);
    assert.equal(rejected.body.code, 'ASSIGNEE_NOT_ELIGIBLE');
  }

  const assigned = await patchTicket(server, 'UNASSIGNED', SUPERVISOR, { worker: '管家', status: 'doing' });
  assert.equal(assigned.response.status, 200);
  assert.deepEqual(
    db.exec("SELECT worker, assignee_user_id, assignee_staff_profile_id FROM tickets WHERE id = 'UNASSIGNED'")[0].values[0],
    ['管家', 4, 4]
  );
  assert.equal((await patchTicket(server, 'UNASSIGNED', KEEPER, { status: 'confirm' })).response.status, 200);
  const completed = await patchTicket(server, 'UNASSIGNED', SUPERVISOR, {
    status: 'done', finished: '2026-08-12T12:00:00.000Z',
  });
  assert.equal(completed.response.status, 200);
});
