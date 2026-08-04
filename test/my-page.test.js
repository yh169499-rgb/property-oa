const assert = require('node:assert/strict');
const test = require('node:test');
const { buildMyPageModel } = require('../public/js/my-page.js');

test('builds personal schedule from server calendar data', () => {
  const model = buildMyPageModel({ id: 9, name: '测试师傅', position: '维修师傅' }, {
    received: { total: 2 }, completed: { total: 1 },
  }, [], 'month', {
    date: '2026-08-04',
    people: [{
      id: 9,
      shift: {
        assignmentType: 'work', templateName: '标准白班', templateColor: '#2f6fed',
        startAt: '2026-08-04T08:00:00+08:00', endAt: '2026-08-04T18:00:00+08:00',
      },
      attendance: { status: 'normal', checkInAt: '2026-08-04T07:58:00+08:00' },
    }],
    events: [{
      ticketId: 'DEMO-1', category: '水电', description: '漏水', location: '1栋',
      status: 'doing', startAt: '2026-08-04T09:00:00+08:00', endAt: '2026-08-04T10:00:00+08:00',
    }],
    conflicts: [],
  });
  assert.equal(model.schedule.date, '2026-08-04');
  assert.equal(model.schedule.shift.templateName, '标准白班');
  assert.equal(model.schedule.attendance.status, 'normal');
  assert.equal(model.schedule.events[0].ticketId, 'DEMO-1');
  assert.equal(model.schedule.hasConflict, false);
});

test('shows explicit empty schedule states', () => {
  const model = buildMyPageModel({ id: 9, name: '测试师傅' }, {}, [], 'month', {
    date: '2026-08-05', people: [{ id: 9, shift: null, attendance: null }], events: [], conflicts: [],
  });
  assert.equal(model.schedule.shift, null);
  assert.equal(model.schedule.events.length, 0);
  assert.equal(model.schedule.emptyShiftLabel, '今天未安排班次');
  assert.equal(model.schedule.emptyEventsLabel, '暂无工单时间块');
});
