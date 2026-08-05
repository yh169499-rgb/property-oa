const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getSupabaseStorageConfig,
  ensureBucket,
  uploadObject,
  atomicWriteFile,
  createUploadQueue,
} = require('../services/supabase-storage');

test('缺少 Supabase 凭据时不启用远程同步', () => {
  assert.equal(getSupabaseStorageConfig({}), null);
  assert.equal(getSupabaseStorageConfig({ SUPABASE_URL: 'https://example.supabase.co' }), null);
});

test('Supabase 配置使用安全默认值并去除 URL 尾部斜杠', () => {
  assert.deepEqual(getSupabaseStorageConfig({
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_SERVICE_ROLE_KEY: 'secret',
  }), {
    url: 'https://example.supabase.co',
    serviceRoleKey: 'secret',
    bucket: 'property-oa-data',
    dbObject: 'production/data.db',
    backupPrefix: 'backups',
    syncRequired: false,
  });
});

test('原子写入不会留下临时文件', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-storage-'));
  const target = path.join(directory, 'data.db');
  atomicWriteFile(target, Buffer.from('snapshot'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'snapshot');
  assert.deepEqual(fs.readdirSync(directory), ['data.db']);
});

test('远程上传队列按顺序执行', async () => {
  const order = [];
  const queue = createUploadQueue(async value => {
    order.push(`start:${value}`);
    await new Promise(resolve => setTimeout(resolve, 2));
    order.push(`end:${value}`);
  });
  await Promise.all([queue.enqueue('a'), queue.enqueue('b')]);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('首次同步时自动创建私有 bucket', async () => {
  const calls = [];
  const response = (status, body = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    return calls.length === 1 ? response(404) : response(200, { id: 'property-oa-data' });
  };
  const config = getSupabaseStorageConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'secret',
  });
  await ensureBucket(config, fakeFetch);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.match(calls[1].options.body, /"public":false/);
});

test('新版 Secret key 只通过 apikey 发送，避免被 Storage 当作 JWT 解析', async () => {
  let request;
  const config = getSupabaseStorageConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
  });
  await uploadObject(config, 'backups/test.data.db', Buffer.from('snapshot'), async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async text() { return ''; } };
  });
  assert.equal(request.options.headers.apikey, 'sb_secret_test');
  assert.equal(request.options.headers.Authorization, undefined);
});

test('旧版 service_role 继续通过 Bearer 发送', async () => {
  let request;
  const config = getSupabaseStorageConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role',
  });
  await uploadObject(config, 'backups/test.data.db', Buffer.from('snapshot'), async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, async text() { return ''; } };
  });
  assert.equal(request.options.headers.Authorization, 'Bearer legacy-service-role');
});
