const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildWorkerHomeModel } = require('../public/js/worker-home');

test('师傅首页只汇总本人工作与日程，不包含考勤字段', () => {
  const model = buildWorkerHomeModel(
    { id: 9, name: '测试师傅', position: '维修师傅' },
    {
      received: { total: 6 },
      completed: { total: 4, averageHours: 2.5, onTimeRate: 75 },
      current: { doing: 2, pending: 1, waiting: 0, returned: 1 },
      attendance: { actualDays: 20, late: 2 },
    },
    {
      date: '2026-08-07',
      people: [{
        id: 9,
        shift: {
          assignmentType: 'work', templateName: '标准白班',
          startAt: '2026-08-07T08:00:00+08:00', endAt: '2026-08-07T18:00:00+08:00',
        },
        attendance: { status: 'late' },
      }],
      events: [{
        staffId: 9, ticketId: 'WX001', category: '水暖', status: 'doing',
        startAt: '2026-08-07T09:00:00+08:00', endAt: '2026-08-07T10:00:00+08:00',
      }],
      conflicts: [{ ticketIds: ['WX001', 'WX002'] }],
    },
  );

  assert.equal(model.name, '测试师傅');
  assert.equal(model.metrics.received, 6);
  assert.equal(model.metrics.doing, 2);
  assert.equal(model.schedule.shift.templateName, '标准白班');
  assert.equal(model.schedule.events[0].ticketId, 'WX001');
  assert.equal(model.schedule.hasConflict, true);
  assert.deepEqual(model.schedule.conflictTicketIds, ['WX001', 'WX002']);
  assert.equal('attendance' in model, false);
  assert.equal('attendance' in model.schedule, false);
});

test('师傅首页明确班次是可派时间且使用北京时间显示工单', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/worker-home.js'), 'utf8');
  assert.match(source, /该时段内可派单/);
  assert.match(source, /shanghaiTime/);
  assert.doesNotMatch(source, /startAt\s*\|\|\s*''\)\.slice\(11, 16\)/);
  assert.match(source, /工单.*时间重叠/);
});

test('师傅端保留首页与我的，移除旧本月出勤和手动在岗状态界面', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  assert.match(html, /id="page-worker-home"/);
  assert.match(html, /js\/worker-home\.js/);
  assert.doesNotMatch(app, /本月出勤|renderMyStatus|updateMyStatus|my-status-card/);
});
