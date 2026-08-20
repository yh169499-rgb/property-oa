const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const test = require('node:test');
const { createTestDB } = require('./helpers/test-db');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { ensureStandaloneManager } = require('../services/standalone-manager');
const { runStartupStandaloneManager } = require('../services/startup-standalone-manager');

function one(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const value = statement.step() ? statement.getAsObject() : null;
  statement.free();
  return value;
}

async function fixture() {
  const db = await createTestDB();
  ensureWorkforceSchema(db);
  db.run(`INSERT INTO tickets (id, worker) VALUES ('existing-ticket', '张师傅')`);
  return db;
}

const input = {
  phone: '13222514178',
  name: '发财',
  password: 'Test@123456',
  now: '2026-08-14T08:00:00.000Z',
};

test('新增独立主管不触碰既有工单且重复执行幂等', async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  const first = ensureStandaloneManager(db, input);
  const second = ensureStandaloneManager(db, input);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM users WHERE phone = ?', [input.phone]).total, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM staff_profiles WHERE user_id = ?', [first.userId]).total, 1);
  assert.deepEqual(
    one(db, 'SELECT name, position, manager_id, employment_status FROM staff_profiles WHERE user_id = ?', [first.userId]),
    { name: '发财', position: '主管', manager_id: null, employment_status: 'active' }
  );
  assert.equal(one(db, 'SELECT COUNT(*) AS total FROM tickets').total, 1);
  assert.equal(bcrypt.compareSync(input.password, one(db, 'SELECT password FROM users WHERE phone = ?', [input.phone]).password), true);
});

test('手机号属于普通账号时拒绝提权', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  db.run("INSERT INTO users (phone, password, name, role) VALUES ('13222514178', 'hash', '普通人', 'worker')");

  assert.throws(
    () => ensureStandaloneManager(db, input),
    (error) => error.code === 'STANDALONE_MANAGER_PHONE_CONFLICT'
  );
  assert.equal(one(db, "SELECT role FROM users WHERE phone = '13222514178'").role, 'worker');
});

test('启动开关关闭时不创建主管，开启时要求服务端密码配置', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  let persisted = 0;

  const disabled = await runStartupStandaloneManager({
    db,
    env: {},
    persist: async () => { persisted += 1; },
  });
  assert.equal(disabled.applied, false);
  assert.equal(one(db, "SELECT COUNT(*) AS total FROM users WHERE phone = '13222514178'").total, 0);

  await assert.rejects(
    () => runStartupStandaloneManager({
      db,
      env: {
        APPLY_STANDALONE_MANAGER_ON_START: 'true',
        STANDALONE_MANAGER_PHONE: input.phone,
        STANDALONE_MANAGER_NAME: input.name,
      },
      persist: async () => { persisted += 1; },
    }),
    /缺少 STANDALONE_MANAGER_PASSWORD/
  );
  assert.equal(persisted, 0);
});

test('启动开关开启时创建指定的空白主管并持久化一次', async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  let persisted = 0;
  const result = await runStartupStandaloneManager({
    db,
    env: {
      APPLY_STANDALONE_MANAGER_ON_START: 'true',
      STANDALONE_MANAGER_PHONE: input.phone,
      STANDALONE_MANAGER_NAME: input.name,
      STANDALONE_MANAGER_PASSWORD: input.password,
    },
    persist: async () => { persisted += 1; },
    now: input.now,
  });
  assert.equal(result.applied, true);
  assert.equal(result.summary.hasMockBusinessData, false);
  assert.equal(persisted, 1);
  assert.equal(one(db, 'SELECT manager_id FROM staff_profiles WHERE user_id = ?', [result.summary.userId]).manager_id, null);
});
