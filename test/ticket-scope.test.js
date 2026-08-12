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

const SUPERVISOR = { id: 1, role: '主管', name: '主管' };
const WORKER_A = { id: 2, role: 'worker', name: '同名师傅' };
const WORKER_B = { id: 3, role: 'worker', name: '同名师傅' };
const KEEPER = { id: 4, role: 'keeper', name: '管家' };

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
    (4, '13800000004', 'x', '管家', 'keeper')
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
    (4, 4, '管家', '物业管家', 'active', '2026-01-01', '2026-01-01')
  `);
  db.run(`INSERT INTO community_memberships (community_id, staff_profile_id, created_at) VALUES
    ('c1', 1, '2026-01-01'), ('c1', 2, '2026-01-01'),
    ('c1', 3, '2026-01-01'), ('c1', 4, '2026-01-01')
  `);
  const tickets = [
    ['R-A', 'repair', 'c1', 2, '同名师傅'],
    ['C-A', 'complaint', 'c1', 2, '同名师傅'],
    ['H-A', 'help', 'c2', 2, '同名师傅'],
    ['R-B', 'repair', 'c1', 3, '同名师傅'],
    ['K-A', 'help', 'c1', 4, '管家'],
    ['LEGACY-SAME', 'complaint', 'c1', null, '同名师傅'],
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
  assert.deepEqual(otherWorker.body.data.map((ticket) => ticket.id), ['R-B']);

  const keeper = await request(server, '/api/tickets', KEEPER);
  assert.deepEqual(keeper.body.data.map((ticket) => ticket.id), ['K-A']);
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
  assert.deepEqual(filtered.body.data.map((ticket) => ticket.id), ['K-A']);

  const detail = await request(server, '/api/tickets/R-B', SUPERVISOR);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.id, 'R-B');
});
