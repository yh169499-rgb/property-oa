const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installAsyncRouteSupport } = require('../middleware/async-handler');

test('Express 4 async route rejection reaches the generic error middleware', async (t) => {
  installAsyncRouteSupport();
  const app = express();
  app.get('/boom', async () => {
    throw new Error('secret database detail');
  });
  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/boom`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '服务器内部错误', code: 'INTERNAL_ERROR' });
});
