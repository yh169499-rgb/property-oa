const assert = require('node:assert/strict');
const test = require('node:test');

const utils = require('../public/js/workforce-utils');

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
