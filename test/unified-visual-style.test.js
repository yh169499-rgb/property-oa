const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const styles = fs.readFileSync('public/styles.css', 'utf8');
const workspace = fs.readFileSync('public/js/management-workspace.js', 'utf8');

test('schedule and workspace use the unified blue card visual language', () => {
  assert.match(styles, /#123f78/);
  assert.match(styles, /#1f7cf0/);
  assert.match(styles, /\.management-hero/);
  assert.match(styles, /\.my-schedule-card/);
  assert.match(styles, /\.schedule-agenda/);
  assert.match(styles, /max-width:\s*768px/);
  assert.match(workspace, /management-hero/);
  assert.match(styles, /#page-repair::before/);
  assert.match(styles, /#page-complaint::before/);
  assert.match(styles, /#page-done::before/);
});
