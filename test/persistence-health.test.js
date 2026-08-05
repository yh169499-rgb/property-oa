const assert = require('node:assert/strict');
const test = require('node:test');
const initSqlJs = require('sql.js');
const { startHttpServer } = require('./helpers/http-server');
const { authHeader } = require('./helpers/auth');

test('持久化状态接口仅允许主管查看并返回同步字段', async () => {
  const SQL = await initSqlJs();
  const server = await startHttpServer(new SQL.Database());
  try {
    const anonymous = await fetch(`${server.url}/api/persistence/status`);
    assert.equal(anonymous.status, 401);

    const response = await fetch(`${server.url}/api/persistence/status`, {
      headers: authHeader({ id: 1, role: 'admin', phone: '13800000001' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, {
      remoteEnabled: false,
      pendingUpload: false,
      lastSyncAt: null,
      lastSyncError: null,
      lastRemoteObject: null,
    });
  } finally {
    await server.close();
  }
});