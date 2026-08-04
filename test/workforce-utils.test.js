const assert = require('node:assert/strict');
const test = require('node:test');

const utils = require('../public/js/workforce-utils');
const { buildMyPageModel } = require('../public/js/my-page');

test('detects narrow viewports at the mobile breakpoint', () => {
  assert.equal(utils.isNarrowViewport(767), true);
  assert.equal(utils.isNarrowViewport(1024), false);
});

test('selects day grid on desktop and agenda on narrow screens', () => {
  assert.equal(utils.selectCalendarView(1200), 'day-grid');
  assert.equal(utils.selectCalendarView(767), 'agenda');
});

test('formats calendar dates without converting them through UTC', () => {
  const shanghaiMidnight = new Date('2026-07-31T00:30:00+08:00');
  assert.equal(utils.localDateKey(shanghaiMidnight), '2026-07-31');
});

test('shares same-day and clock formatting helpers', () => {
  assert.equal(
    utils.sameDay(new Date(2026, 6, 31, 0, 1), new Date(2026, 6, 31, 23, 59)),
    true
  );
  assert.equal(utils.sameDay(new Date(2026, 6, 31), new Date(2026, 7, 1)), false);
  assert.equal(utils.fmtHM(new Date(2026, 6, 31, 8, 5)), '08:05');
});

test('labels reporting periods for display', () => {
  assert.equal(utils.periodLabel('month'), '本月');
});

test('appends query parameters only when values are present', () => {
  assert.equal(utils.withQuery('/api/calendar/day'), '/api/calendar/day');
  assert.equal(utils.withQuery('/api/calendar/day', {}), '/api/calendar/day');
  assert.equal(
    utils.withQuery('/api/calendar/day', { date: '2026-07-31', community_id: '' }),
    '/api/calendar/day?date=2026-07-31'
  );
});

test('encodes required path segments and rejects empty identifiers', () => {
  assert.equal(utils.requiredPathSegment('staff/01', 'staffId'), 'staff%2F01');
  assert.throws(
    () => utils.requiredPathSegment('', 'staffId'),
    /staffId is required/
  );
});

test('builds an editable personal month model from actual attendance records', () => {
  const model = buildMyPageModel(
    {
      id: 8,
      name: '张师傅',
      phone: '13800000000',
      birth_month: '07',
      join_date: '2024-01-02',
      position: '维修工',
      manager_name: '王主管',
    },
    {
      received: { total: 6 },
      completed: { total: 4, averageHours: 2.5, onTimeRate: 75 },
      attendance: { actualDays: 3, late: 1 },
    },
    [
      { work_date: '2026-07-02', status: 'normal', check_in: '2026-07-02T00:02:00Z' },
      { work_date: '2026-07-03', status: 'late', check_in: '2026-07-03T01:15:00Z' },
      { work_date: '2026-07-04', status: 'leave' },
    ],
    'month'
  );

  assert.equal(model.period, 'month');
  assert.equal(model.periodLabel, '本月');
  assert.deepEqual(model.editableFields, ['birth_month', 'phone']);
  assert.deepEqual(model.readonlyFields, ['join_date', 'position', 'manager']);
  assert.equal(model.attendance.actualDays, 3);
  assert.equal(model.attendance.late, 1);
  assert.equal(model.calendar.length, 3);
  assert.equal(model.calendar[1].statusLabel, '迟到');
  assert.equal(model.teamResults, null);
});

test('separates a manager personal actions from team results', () => {
  const model = buildMyPageModel(
    { id: 1, name: '王主管', position: '工程主管' },
    {
      personalActions: { total: 5, byAction: { assign: 3, approve: 2 } },
      team: {
        staffIds: [2, 3],
        received: { total: 12 },
        completed: { total: 9, averageHours: 1.8, onTimeRate: 88.9 },
        attendance: { actualDays: 18, late: 2 },
      },
    },
    [],
    'year'
  );

  assert.equal(model.isManager, true);
  assert.equal(model.periodLabel, '本年');
  assert.equal(model.personalActions.total, 5);
  assert.equal(model.teamResults.staffCount, 2);
  assert.equal(model.teamResults.completed, 9);
});
