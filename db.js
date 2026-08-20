/**
 * 数据库初始化 & 工具函数
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('./config');
const { ensureCoreSchema } = require('./services/core-schema');
const { ensureTenantSchema } = require('./services/tenant-schema');
const {
  ensureWorkforceSchema,
  backfillCommunityMemberships,
  backfillDefaultPerformanceRules,
} = require('./workforce-schema');
const {
  migrateUsersToProfiles,
  backfillTicketAssignees,
} = require('./services/workforce-migration');
const {
  getSupabaseStorageConfig,
  ensureBucket,
  downloadDatabase,
  uploadDatabase,
  atomicWriteFile,
  createUploadQueue,
} = require('./services/supabase-storage');
const {
  configurePersistence,
  markUploadPending,
  markUploadSuccess,
  markUploadError,
  getPersistenceStatus,
} = require('./services/persistence-status');

let db;
let persistToDisk = true;
let remoteConfig = getSupabaseStorageConfig(config);
let uploadQueue = createUploadQueue(async bytes => uploadDatabase(remoteConfig, bytes));

function ensureDatabaseSchema(targetDb) {
  targetDb.run('SAVEPOINT ensure_database_schema');
  try {
    ensureCoreSchema(targetDb);
    ensureTenantSchema(targetDb);
    ensureWorkforceSchema(targetDb);
    ensureTenantSchema(targetDb);
    targetDb.run('RELEASE SAVEPOINT ensure_database_schema');
  } catch (error) {
    try {
      targetDb.run('ROLLBACK TO SAVEPOINT ensure_database_schema');
      targetDb.run('RELEASE SAVEPOINT ensure_database_schema');
    } catch (_) {}
    throw error;
  }
}

function backfillWorkforceData(targetDb, nowIso = new Date().toISOString()) {
  targetDb.run('SAVEPOINT backfill_workforce_data');
  try {
    migrateUsersToProfiles(targetDb, nowIso);
    backfillCommunityMemberships(targetDb, nowIso);
    backfillTicketAssignees(targetDb);
    backfillDefaultPerformanceRules(targetDb, nowIso);
    targetDb.run('RELEASE SAVEPOINT backfill_workforce_data');
  } catch (error) {
    try {
      targetDb.run('ROLLBACK TO SAVEPOINT backfill_workforce_data');
      targetDb.run('RELEASE SAVEPOINT backfill_workforce_data');
    } catch (_) {}
    throw error;
  }
}

async function restoreRemoteSnapshot(storageConfig, localPath, download = downloadDatabase) {
  if (!storageConfig) return null;
  const remoteBytes = await download(storageConfig);
  if (!remoteBytes) {
    if (storageConfig.syncRequired) throw new Error('remote database snapshot is required');
    return null;
  }
  atomicWriteFile(localPath, remoteBytes);
  return remoteBytes;
}

async function initDB() {
  remoteConfig = getSupabaseStorageConfig(config);
  configurePersistence(Boolean(remoteConfig));
  if (remoteConfig) {
    try {
      await ensureBucket(remoteConfig);
      await restoreRemoteSnapshot(remoteConfig, config.DB_PATH);
    } catch (error) {
      markUploadError(error);
      if (remoteConfig.syncRequired) throw error;
    }
  }
  const SQL = await initSqlJs();
  if (fs.existsSync(config.DB_PATH)) {
    const buffer = fs.readFileSync(config.DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  ensureDatabaseSchema(db);
  const nowIso = new Date().toISOString();
  backfillWorkforceData(db, nowIso);

  await persistInitialSnapshot(saveDB, Boolean(remoteConfig?.syncRequired));
  return db;
}

async function persistInitialSnapshot(persist = saveDB, syncRequired = false, onError = markUploadError) {
  try {
    await persist();
  } catch (error) {
    onError(error);
    if (syncRequired) throw error;
    console.warn('⚠️ 远程数据库首次同步失败，本地服务继续启动:', error.message);
  }
}

function saveDB() {
  if (!persistToDisk) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
  fs.writeFileSync(config.DB_PATH, buffer);
  if (remoteConfig) {
    markUploadPending();
    const task = uploadQueue.enqueue(buffer);
    task.then(markUploadSuccess).catch(markUploadError);
    return task;
  }
  return Promise.resolve();
}

function flushPersistence() {
  return uploadQueue.flush();
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params) {
  db.run(sql, params);
}

function getDB() { return db; }

function setDBForTests(value) {
  const previousDB = db;
  const previousPersistence = persistToDisk;
  let restored = false;

  db = value;
  persistToDisk = false;

  return function restoreDB() {
    if (restored) return;
    db = previousDB;
    persistToDisk = previousPersistence;
    restored = true;
  };
}

module.exports = {
  initDB,
  saveDB,
  persistInitialSnapshot,
  flushPersistence,
  restoreRemoteSnapshot,
  getPersistenceStatus,
  queryAll,
  queryOne,
  run,
  getDB,
  setDBForTests,
  ensureDatabaseSchema,
  backfillWorkforceData,
};
