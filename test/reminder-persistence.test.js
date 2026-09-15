const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createFullTestDB, tableNames } = require('./helpers/tenant-fixture');

test('提醒发送状态使用租户表持久保存', async () => {
  const db = await createFullTestDB();
  assert.ok(tableNames(db).includes('ticket_reminder_state'));
  const columns = db.exec('PRAGMA table_info(ticket_reminder_state)')[0].values.map((row) => row[1]);
  assert.deepEqual(columns, ['tenant_id', 'ticket_id', 'status', 'last_sent_at']);
});

test('服务启动时恢复已保存的租户提醒任务', () => {
  const source = fs.readFileSync(require.resolve('../index-new.js'), 'utf8');
  assert.match(source, /restoreReminderSchedulers/);
  assert.match(source, /await\s+restoreReminderSchedulers\(getDB\(\),/);
});

test('按状态读取和持久保存提醒时长，兼容旧统一配置', async () => {
  const { getReminderIntervals, setReminderInterval, setReminderIntervals } = require('../services/ticket-reminders');
  const db = await createFullTestDB();
  db.run(`INSERT INTO tenants (id,name,status,staff_limit,created_at,updated_at)
    VALUES ('tenant-a','企业 A','active',4,'2026-09-04','2026-09-04')`);
  setReminderInterval(db, 'tenant-a', 7, '2026-09-04T00:00:00.000Z');
  assert.deepEqual(getReminderIntervals(db, 'tenant-a'), { wait: 7, pending: 7, confirm: 7 });
  assert.deepEqual(setReminderIntervals(db, 'tenant-a', { wait: 5, pending: 15, confirm: 30 }), {
    wait: 5, pending: 15, confirm: 30,
  });
  assert.deepEqual(getReminderIntervals(db, 'tenant-a'), { wait: 5, pending: 15, confirm: 30 });
  assert.throws(
    () => setReminderIntervals(db, 'tenant-a', { wait: 1.5, pending: 0, confirm: 0 }),
    (error) => error.code === 'INVALID_REMINDER_INTERVALS' && error.status === 400,
  );
});

test('只提醒 wait、pending、confirm，doing 永远不提醒且同状态按间隔重复', async () => {
  const { runDueReminders, setReminderIntervals } = require('../services/ticket-reminders');
  const db = await createFullTestDB();
  db.run(`
    INSERT INTO tenants (id,name,status,staff_limit,created_at,updated_at)
      VALUES ('tenant-a','企业 A','active',4,'2026-09-04','2026-09-04');
    INSERT INTO tickets (id,tenant_id,type,cat,status,worker,created,community_id) VALUES
      ('WX-WAIT','tenant-a','repair','水暖','wait','','2026-09-04T00:00:00.000Z','c1'),
      ('WX-DOING','tenant-a','repair','电路','doing','张师傅','2026-09-04T00:00:00.000Z','c1'),
      ('WX-PENDING','tenant-a','repair','门窗','pending','张师傅','2026-09-04T00:00:00.000Z','c1'),
      ('WX-CONFIRM','tenant-a','repair','公共设施','confirm','张师傅','2026-09-04T00:00:00.000Z','c1');
  `);
  setReminderIntervals(db, 'tenant-a', { wait: 10, pending: 15, confirm: 30 }, '2026-09-04T00:00:00.000Z');
  const sent = [];
  const send = async (payload) => { sent.push(payload); return { success: true }; };
  await runDueReminders({ db, tenantId: 'tenant-a', now: new Date('2026-09-04T00:16:00.000Z'), send });
  assert.deepEqual(sent.map((item) => item.ticket.id).sort(), ['WX-PENDING', 'WX-WAIT']);
  assert.ok(sent.every((item) => item.kind === 'overdue_manager'));
  await runDueReminders({ db, tenantId: 'tenant-a', now: new Date('2026-09-04T00:32:00.000Z'), send });
  assert.deepEqual(sent.map((item) => item.ticket.id).sort(), ['WX-CONFIRM', 'WX-PENDING', 'WX-PENDING', 'WX-WAIT', 'WX-WAIT']);
  assert.equal(sent.filter((item) => item.ticket.id === 'WX-DOING').length, 0);
  assert.equal(sent.filter((item) => item.ticket.id === 'WX-CONFIRM').length, 1);
});

test('状态提醒关闭后不再扫描，配置按租户隔离', async () => {
  const { getReminderIntervals, runDueReminders, setReminderIntervals } = require('../services/ticket-reminders');
  const db = await createFullTestDB();
  db.run(`INSERT INTO tenants (id,name,status,staff_limit,created_at,updated_at)
    VALUES ('tenant-a','企业 A','active',4,'2026-09-04','2026-09-04'),
           ('tenant-b','企业 B','active',4,'2026-09-04','2026-09-04')`);
  setReminderIntervals(db, 'tenant-a', { wait: 0, pending: 0, confirm: 0 });
  setReminderIntervals(db, 'tenant-b', { wait: 5, pending: 0, confirm: 0 });
  assert.deepEqual(getReminderIntervals(db, 'tenant-a'), { wait: 0, pending: 0, confirm: 0 });
  assert.deepEqual(getReminderIntervals(db, 'tenant-b'), { wait: 5, pending: 0, confirm: 0 });
  const result = await runDueReminders({ db, tenantId: 'tenant-a', now: new Date(), send: async () => ({ success: true }) });
  assert.deepEqual(result, { checked: 0, sent: 0 });
});
