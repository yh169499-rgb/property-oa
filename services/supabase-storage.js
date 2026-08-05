const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fetch = require('node-fetch');

function getSupabaseStorageConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceRoleKey) return null;
  return {
    url,
    serviceRoleKey,
    bucket: String(env.SUPABASE_STORAGE_BUCKET || 'property-oa-data').trim(),
    dbObject: String(env.SUPABASE_DB_OBJECT || 'production/data.db').replace(/^\/+/, ''),
    backupPrefix: String(env.SUPABASE_BACKUP_PREFIX || 'backups').replace(/^\/+|\/+$/g, ''),
    syncRequired: String(env.SUPABASE_SYNC_REQUIRED || '').toLowerCase() === 'true',
  };
}

function objectUrl(config, objectPath) {
  return `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${objectPath
    .split('/').map(encodeURIComponent).join('/')}`;
}

function headers(config, extra = {}) {
  const result = {
    apikey: config.serviceRoleKey,
    ...extra,
  };
  // 新版 sb_secret_* 是 opaque key，不是 JWT；放进 Bearer 会被 Storage
  // 当成普通/无效 JWT 解析，最终按 RLS 规则拒绝写入。旧版 service_role
  // 仍需 Bearer 头以保持兼容。
  if (!config.serviceRoleKey.startsWith('sb_secret_')) {
    result.Authorization = `Bearer ${config.serviceRoleKey}`;
  }
  return result;
}

async function responseError(response, action) {
  const body = await response.text().catch(() => '');
  const error = new Error(`${action} failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  error.status = response.status;
  return error;
}

async function downloadDatabase(config, fetchImpl = fetch) {
  const response = await fetchImpl(objectUrl(config, config.dbObject), {
    method: 'GET',
    headers: headers(config),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response, 'download database');
  return Buffer.from(await response.arrayBuffer());
}

async function ensureBucket(config, fetchImpl = fetch) {
  const bucketUrl = `${config.url}/storage/v1/bucket/${encodeURIComponent(config.bucket)}`;
  const existing = await fetchImpl(bucketUrl, { method: 'GET', headers: headers(config) });
  if (existing.ok) return false;
  if (existing.status !== 404) throw await responseError(existing, 'check storage bucket');
  const created = await fetchImpl(`${config.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: config.bucket, name: config.bucket, public: false }),
  });
  if (!created.ok) throw await responseError(created, 'create storage bucket');
  return true;
}

async function uploadObject(config, objectPath, bytes, fetchImpl = fetch) {
  const response = await fetchImpl(objectUrl(config, objectPath), {
    method: 'POST',
    headers: headers(config, {
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
    }),
    body: bytes,
  });
  if (!response.ok) throw await responseError(response, `upload ${objectPath}`);
  return response;
}

async function uploadDatabase(config, bytes, fetchImpl = fetch, now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const backupPath = `${config.backupPrefix}/${timestamp}-${digest}.data.db`;
  await uploadObject(config, backupPath, bytes, fetchImpl);
  await uploadObject(config, config.dbObject, bytes, fetchImpl);
  return { backupPath, bytes: bytes.length, sha256: digest };
}

function atomicWriteFile(targetPath, bytes) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function createUploadQueue(upload) {
  let tail = Promise.resolve();
  return {
    enqueue(value) {
      const current = tail.then(() => upload(value));
      tail = current.catch(() => {});
      return current;
    },
    flush() { return tail; },
  };
}

module.exports = {
  getSupabaseStorageConfig,
  downloadDatabase,
  ensureBucket,
  uploadDatabase,
  uploadObject,
  atomicWriteFile,
  createUploadQueue,
};
