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

test('到期提醒按状态选择主管或处理人并持久去重', async () => {
  const {
    runDueReminders,
    setReminderInterval,
  } = require('../services/ticket-reminders');
  const db = await createFullTestDB();
  db.run(`
    INSERT INTO tenants (id,name,status,staff_limit,created_at,updated_at)
      VALUES ('tenant-a','企业 A','active',4,'2026-09-04','2026-09-04');
    INSERT INTO tickets
      (id,tenant_id,type,cat,status,worker,created,community_id) VALUES
      ('WX-WAIT','tenant-a','repair','水暖','wait','','2026-09-04T00:00:00.000Z','c1'),
      ('WX-DOING','tenant-a','repair','电路','doing','张师傅','2026-09-04T00:00:00.000Z','c1');
  `);
  setReminderInterval(db, 'tenant-a', 10, '2026-09-04T00:00:00.000Z');
  const sent = [];
  const send = async (payload) => {
    sent.push(payload);
    return { success: true };
  };

  await runDueReminders({ db, tenantId: 'tenant-a', now: new Date('2026-09-04T00:11:00.000Z'), send });
  await runDueReminders({ db, tenantId: 'tenant-a', now: new Date('2026-09-04T00:11:30.000Z'), send });

  assert.deepEqual(sent.map((item) => item.kind).sort(), ['overdue_manager', 'overdue_worker']);
  assert.equal(db.exec("SELECT COUNT(*) FROM ticket_reminder_state WHERE tenant_id='tenant-a'")[0].values[0][0], 2);
});
