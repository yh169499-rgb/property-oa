const assert = require('node:assert/strict');
const test = require('node:test');
const { startHttpServer } = require('./helpers/http-server');

test('testable app serves the work order system home page', async (t) => {
  const server = await startHttpServer();
  t.after(server.close);

  const response = await fetch(`${server.url}/`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html\b/);
  assert.match(body, /工单系统/);
});
