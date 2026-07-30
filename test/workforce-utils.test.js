const assert = require('node:assert/strict');
const test = require('node:test');

const utils = require('../public/js/workforce-utils');

test('detects narrow viewports at the mobile breakpoint', () => {
  assert.equal(utils.isNarrowViewport(767), true);
  assert.equal(utils.isNarrowViewport(1024), false);
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
