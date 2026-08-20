const initSqlJs = require('sql.js');

const { ensureCoreSchema } = require('../../services/core-schema');
const { ensureWorkforceSchema } = require('../../workforce-schema');
const { ensureTenantSchema } = require('../../services/tenant-schema');
const { startHttpServer } = require('./http-server');

async function createFullTestDB() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  ensureCoreSchema(db);
  ensureTenantSchema(db);
  ensureWorkforceSchema(db);
  ensureTenantSchema(db);
  return db;
}

function rows(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result[0]) return [];
  const { columns, values } = result[0];
  return values.map((valuesRow) => Object.fromEntries(
    columns.map((column, index) => [column, valuesRow[index]])
  ));
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function tableNames(db) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => row.name);
}

function columnNames(db, table) {
  return rows(db, `PRAGMA table_info(${table})`).map((row) => row.name);
}

function indexNames(db) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'index'")
    .map((row) => row.name);
}

function seedTenant(db, options = {}) {
  const {
    id: configuredId,
    tenantId,
    name = '测试企业', status = 'active', staffLimit = 999,
  } = options;
  const id = configuredId || tenantId || 'tenant-test';
  if (typeof db?.exec !== 'function'
      || !db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")[0]) {
    throw new Error('seedTenant requires a users table');
  }
  const columns = new Set(db.exec('PRAGMA table_info(users)')[0].values.map(row => row[1]));
  if (!columns.has('status')) db.run("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!columns.has('tenant_id')) db.run("ALTER TABLE users ADD COLUMN tenant_id TEXT DEFAULT ''");
  if (!columns.has('session_version')) db.run('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  if (!db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tenants'")[0]) {
    db.run(`CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT,status TEXT,owner_user_id INTEGER,
      staff_limit INTEGER,created_at TEXT,updated_at TEXT)`);
  }
  db.run(`INSERT OR IGNORE INTO tenants
    (id,name,status,owner_user_id,staff_limit,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
  [id, name, status, null, staffLimit, 'test', 'test']);
  db.run(`UPDATE users SET tenant_id=?
    WHERE role<>'platform_owner' AND COALESCE(tenant_id,'')=''`, [id]);
  for (const table of [
    'staff_profiles', 'communities', 'community_permissions',
    'community_memberships', 'invite_codes', 'pending_registrations',
    'tickets', 'staff_status', 'shift_templates', 'shift_assignments',
    'attendance_records', 'attendance_change_logs', 'tenant_settings',
    'ticket_activity_logs', 'workforce_import_batches',
    'performance_rule_versions', 'ai_report_analyses', 'staff_lifecycle_audit',
  ]) {
    if (!tableNames(db).includes(table)) continue;
    if (!columnNames(db, table).includes('tenant_id')) {
      db.run(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT DEFAULT ''`);
    }
    db.run(`UPDATE ${table} SET tenant_id=? WHERE COALESCE(tenant_id,'')=''`, [id]);
  }
  db.run(`UPDATE tenants SET owner_user_id=(SELECT id FROM users
    WHERE role='主管' AND status='active' AND tenant_id=? ORDER BY id LIMIT 1)
    WHERE id=?`, [id, id]);
  return id;
}

async function tenantServer(db, appOptions, tenantOptions) {
  seedTenant(db, tenantOptions);
  return startHttpServer(db, appOptions);
}

module.exports = {
  createFullTestDB,
  rows,
  one,
  tableNames,
  columnNames,
  indexNames,
  seedTenant,
  tenantServer,
};
