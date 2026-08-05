/**
 * 数据库初始化 & 工具函数
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('./config');
const { ensureWorkforceSchema } = require('./workforce-schema');
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

  // 工单表
  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'repair',
      cat TEXT NOT NULL DEFAULT '其他',
      desc TEXT DEFAULT '',
      loc TEXT DEFAULT '',
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'wait',
      worker TEXT DEFAULT '',
      message TEXT DEFAULT '',
      created TEXT NOT NULL,
      finished TEXT DEFAULT '',
      reject_reason TEXT DEFAULT '',
      estimated_hours REAL DEFAULT 0,
      session_id TEXT DEFAULT '',
      community_id TEXT DEFAULT 'default',
      repeat_key TEXT DEFAULT '',
      repeat_of TEXT DEFAULT '',
      repeat_count INTEGER DEFAULT 1,
      is_recurring INTEGER DEFAULT 0,
      recurrence_note TEXT DEFAULT '',
      feedback_count INTEGER DEFAULT 1,
      metadata TEXT DEFAULT '{}'
    )
  `);

  // 小区表
  db.run(`
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      created TEXT NOT NULL
    )
  `);

  // 小区-人员权限表
  db.run(`
    CREATE TABLE IF NOT EXISTS community_permissions (
      community_id TEXT NOT NULL,
      staff_name TEXT NOT NULL,
      PRIMARY KEY (community_id, staff_name)
    )
  `);

  // 邀请码表
  db.run(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      created TEXT NOT NULL
    )
  `);

  // 待审核注册表
  db.run(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker',
      skill TEXT DEFAULT '',
      community_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created TEXT NOT NULL
    )
  `);

  // 用户表
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker'
    )
  `);

  // 人员状态表
  db.run(`
    CREATE TABLE IF NOT EXISTS staff_status (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'on',
      updated TEXT
    )
  `);

  // 兼容旧数据库的列迁移
  const migrations = [
    `ALTER TABLE tickets ADD COLUMN session_id TEXT DEFAULT ''`,
    `ALTER TABLE tickets ADD COLUMN community_id TEXT DEFAULT 'default'`,
    `ALTER TABLE tickets ADD COLUMN repeat_key TEXT DEFAULT ''`,
    `ALTER TABLE tickets ADD COLUMN repeat_of TEXT DEFAULT ''`,
    `ALTER TABLE tickets ADD COLUMN repeat_count INTEGER DEFAULT 1`,
    `ALTER TABLE tickets ADD COLUMN is_recurring INTEGER DEFAULT 0`,
    `ALTER TABLE tickets ADD COLUMN recurrence_note TEXT DEFAULT ''`,
    `ALTER TABLE tickets ADD COLUMN feedback_count INTEGER DEFAULT 1`,
    `ALTER TABLE tickets ADD COLUMN metadata TEXT DEFAULT '{}'`,
  ];
  migrations.forEach(sql => { try { db.run(sql); } catch(e) { /* 已存在 */ } });

  db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_recurrence ON tickets (community_id, repeat_key, created)`);
  ensureWorkforceSchema(db);
  const nowIso = new Date().toISOString();
  migrateUsersToProfiles(db, nowIso);
  backfillTicketAssignees(db);

  // 确保默认小区存在
  const defaultCommunity = queryOne("SELECT id FROM communities WHERE id = 'default'");
  if (!defaultCommunity) {
    db.run("INSERT INTO communities (id, name, address, created) VALUES ('default', '默认小区', '', ?)", [nowIso]);
  }

  await saveDB();
  return db;
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
  flushPersistence,
  restoreRemoteSnapshot,
  getPersistenceStatus,
  queryAll,
  queryOne,
  run,
  getDB,
  setDBForTests,
};