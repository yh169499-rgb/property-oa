const assert = require('node:assert/strict');
const test = require('node:test');
const { buildMyPageModel, calendarPayload } = require('../public/js/my-page.js');

test('兼容日历接口直接返回日历对象，避免我的页面读取 undefined.date', () => {
  const payload = { date: '2026-08-05', people: [], events: [], conflicts: [] };
  assert.deepEqual(calendarPayload({ ok: true, ...payload }), payload);
  assert.deepEqual(calendarPayload({ ok: true, data: payload }), payload);
  assert.deepEqual(calendarPayload({ ok: false }), {});
});

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
  assert.equal('attendance' in model.schedule, false);
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

test('主管个人中心显示本期本人处理工单和团队结果', () => {
  const model = buildMyPageModel({ id: 1, name: '主管', position: '主管', join_date: '2026-01-01' }, {
    personalActions: { total: 3 },
    personalResults: { received: { total: 4 }, completed: { total: 2, onTimeRate: 50 } },
    team: { staffIds: [2], received: { total: 8 }, completed: { total: 7 }, attendance: { actualDays: 5 } },
  }, [], 'month', { date: '2026-08-05', people: [], events: [], conflicts: [] });
  assert.equal(model.isManager, true);
  assert.equal(model.managerResults.received, 4);
  assert.equal(model.managerResults.completed, 2);
  assert.equal(model.teamResults.received, 8);
});

test('主管统计接口暂时无数据时，个人中心仍可渲染零值', () => {
  const model = buildMyPageModel({ id: 1, name: '主管', position: '主管' }, {}, [], 'month', {
    date: '2026-08-05', people: [], events: [], conflicts: [],
  });
  assert.equal(model.isManager, true);
  assert.equal(model.managerResults.received, 0);
  assert.equal(model.teamResults.staffCount, 0);
});

test('个人中心忽略历史考勤数据，只保留资料、成果和日程', () => {
  const model = buildMyPageModel({ id: 1, name: '主管', position: '主管' }, {}, [
    { id: 42, work_date: '2026-08-05', status: 'late' },
  ], 'month', { date: '2026-08-05', people: [], events: [], conflicts: [] });
  assert.equal('attendance' in model, false);
  assert.equal('calendar' in model, false);
  assert.equal(model.isManager, true);
});
