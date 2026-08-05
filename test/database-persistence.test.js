const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  restoreRemoteSnapshot,
  getPersistenceStatus,
} = require('../db');

test('远程快照优先恢复本地数据库', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-persistence-'));
  const localPath = path.join(directory, 'data.db');
  fs.writeFileSync(localPath, 'stale');
  const remoteBytes = Buffer.from('remote-snapshot');
  await restoreRemoteSnapshot({ syncRequired: true }, localPath, async () => remoteBytes);
  assert.equal(fs.readFileSync(localPath, 'utf8'), 'remote-snapshot');
});

test('同步必需时远程快照不存在会拒绝启动', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-persistence-'));
  const localPath = path.join(directory, 'data.db');
  await assert.rejects(
    restoreRemoteSnapshot({ syncRequired: true }, localPath, async () => null),
    /remote database snapshot is required/
  );
});

test('未配置 Supabase 时同步状态保持本地模式', () => {
  const status = getPersistenceStatus();
  assert.equal(status.remoteEnabled, false);
  assert.equal(status.pendingUpload, false);
});