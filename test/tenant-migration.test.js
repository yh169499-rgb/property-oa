const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const database = require('../db');
const { ensureCoreSchema } = require('../services/core-schema');
const {
  inspectTenantMigration,
  applyTenantMigration,
  assertTenantIntegrity,
} = require('../services/tenant-migration');
const {
  CONFIRM_PHRASE,
  migrateMultiTenantFile,
} = require('../scripts/migrate-multi-tenant');
const {
  createFullTestDB,
  rows,
  one,
} = require('./helpers/tenant-fixture');

const MIGRATION_INPUT = Object.freeze({
  testSupervisorPhone: '13800000001',
  testTenantId: 'tenant-test',
  testTenantName: '全流程测试企业',
  testStaffLimit: 4,
  nowIso: '2026-08-19T00:00:00.000Z',
});

async function legacyFixture() {
  const db = await createFullTestDB();
  db.run(`INSERT INTO users(id,phone,password,name,role,status,tenant_id) VALUES
    (1,'13800000001','super-secret-password-hash-token','测试主管','主管','active',''),
    (2,'13800000002','worker-secret','张师傅','worker','active',''),
    (99,'13800000099','platform-secret','平台账号','platform_owner','active',NULL)`);
  db.run(`INSERT INTO staff_profiles
    (id,tenant_id,user_id,name,employment_status,created_at,updated_at) VALUES
    (101,'',1,'测试主管','active','old','old'),
    (102,'',2,'张师傅','active','old','old')`);
  db.run(`INSERT INTO communities(id,name,created,tenant_id) VALUES
    ('legacy-community','旧测试小区','2026-01-01','')`);
  db.run(`INSERT INTO community_permissions(community_id,staff_name,tenant_id) VALUES
    ('legacy-community','张师傅','')`);
  db.run(`INSERT INTO community_memberships
    (tenant_id,community_id,staff_profile_id,created_at) VALUES
    ('','legacy-community',102,'old')`);
  db.run(`INSERT INTO performance_rule_versions (
    id,tenant_id,version_no,name,completion_weight,on_time_weight,quality_weight,
    excellent_threshold,good_threshold,qualified_threshold,minimum_sample_size,
    effective_at,created_at,is_active
  ) VALUES (501,'',1,'旧规则',30,50,20,90,80,60,1,'old','old',1)`);
  db.run(`INSERT INTO tickets (
    id,type,created,community_id,worker,assignee_user_id,
    assignee_staff_profile_id,performance_rule_version_id,tenant_id
  ) VALUES
    ('REAL-HISTORY-1','repair','2026-01-01','legacy-community','张师傅',2,102,501,''),
    ('MOCK-E2E-1','help','2026-01-02','legacy-community','张师傅',2,102,501,'')`);
  db.run(`INSERT INTO shift_templates(id,tenant_id,name) VALUES (201,'','旧班次')`);
  db.run(`INSERT INTO shift_assignments
    (id,tenant_id,staff_id,work_date,template_id) VALUES (301,'',102,'2026-01-01',201)`);
  db.run(`INSERT INTO attendance_records
    (id,tenant_id,staff_id,shift_assignment_id,work_date) VALUES (401,'',102,301,'2026-01-01')`);
  return db;
}

function migrationCounts(db) {
  const tables = [
    'users', 'staff_profiles', 'communities', 'community_permissions',
    'community_memberships', 'performance_rule_versions', 'tickets',
    'shift_templates', 'shift_assignments', 'attendance_records',
  ];
  return Object.fromEntries(tables.map((table) => [
    table,
    Number(one(db, `SELECT COUNT(*) AS count FROM ${table}`).count),
  ]));
}

async function writeLegacyDatabase() {
  const db = await legacyFixture();
  const directory = fs.mkdtempSync('/tmp/tenant-migration-');
  const source = path.join(directory, 'candidate.db');
  fs.writeFileSync(source, Buffer.from(db.export()));
  db.close();
  return { directory, source };
}

async function writePreTenantDatabase() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  ensureCoreSchema(db);
  db.run(`INSERT INTO users(id,phone,password,name,role,status) VALUES
    (1,'13800000001','old-secret','测试主管','主管','active'),
    (2,'13800000002','old-worker','张师傅','worker','active')`);
  db.run(`INSERT INTO communities(id,name,created) VALUES
    ('legacy-community','旧小区','old')`);
  db.run(`INSERT INTO tickets(id,type,created,community_id,worker) VALUES
    ('RAW-LEGACY','repair','old','legacy-community','张师傅')`);
  const directory = fs.mkdtempSync('/tmp/pre-tenant-migration-');
  const source = path.join(directory, 'candidate.db');
  fs.writeFileSync(source, Buffer.from(db.export()));
  db.close();
  return { directory, source };
}

test('inspect is read-only, reports every empty-tenant table, and redacts secrets', async (t) => {
  const db = await legacyFixture();
  t.after(() => db.close());
  const before = Buffer.from(db.export());

  const result = inspectTenantMigration(db, MIGRATION_INPUT);

  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  for (const table of [
    'users', 'staff_profiles', 'communities', 'community_permissions',
    'community_memberships', 'performance_rule_versions', 'tickets',
  ]) {
    assert.ok(result.emptyTenantRows.some((item) => item.table === table && item.count > 0), table);
  }
  assert.deepEqual(Buffer.from(db.export()), before);
  const summary = JSON.stringify(result);
  assert.doesNotMatch(summary, /super-secret|worker-secret|platform-secret/i);
  assert.doesNotMatch(summary, /password|hash|token/i);
});

test('apply preserves historical rows, binds legacy data, and keeps platform accounts global', async (t) => {
  const db = await legacyFixture();
  t.after(() => db.close());
  const before = migrationCounts(db);

  const result = applyTenantMigration(db, MIGRATION_INPUT);

  assert.equal(result.applied, true);
  assert.deepEqual(migrationCounts(db), before);
  assert.deepEqual(one(db, `SELECT id,name,status,owner_user_id,staff_limit
    FROM tenants WHERE id='tenant-test'`), {
    id: 'tenant-test',
    name: '全流程测试企业',
    status: 'active',
    owner_user_id: 1,
    staff_limit: 4,
  });
  assert.equal(one(db, "SELECT tenant_id FROM users WHERE id=99").tenant_id, null);
  assert.deepEqual(rows(db, `SELECT id,tenant_id FROM tickets ORDER BY id`), [
    { id: 'MOCK-E2E-1', tenant_id: 'tenant-test' },
    { id: 'REAL-HISTORY-1', tenant_id: 'tenant-test' },
  ]);
  assert.equal(assertTenantIntegrity(db).ok, true);
});

test('apply is idempotent and keeps tenant and association counts stable', async (t) => {
  const db = await legacyFixture();
  t.after(() => db.close());
  applyTenantMigration(db, MIGRATION_INPUT);
  const first = migrationCounts(db);

  const second = applyTenantMigration(db, MIGRATION_INPUT);

  assert.equal(second.applied, true);
  assert.deepEqual(migrationCounts(db), first);
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM tenants WHERE id='tenant-test'").count, 1);
  assert.equal(assertTenantIntegrity(db).ok, true);
});

test('inspect reports supervisor, orphan, owner, and staff-limit conflicts without writing', async (t) => {
  const db = await legacyFixture();
  t.after(() => db.close());
  db.run(`INSERT INTO users(phone,password,name,role,status,tenant_id)
    VALUES('13900000000','another-secret','另一主管','主管','active','')`);
  db.run(`INSERT INTO tickets(id,type,created,community_id,tenant_id)
    VALUES('ORPHAN','repair','old','missing-community','')`);
  db.run(`INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at)
    VALUES('broken-owner','无主企业','active',4,'old','old')`);
  db.run(`PRAGMA ignore_check_constraints=ON`);
  db.run(`INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at)
    VALUES('bad-limit','错误上限','disabled',1.5,'old','old')`);
  db.run(`PRAGMA ignore_check_constraints=OFF`);
  const before = Buffer.from(db.export());

  const result = inspectTenantMigration(db, MIGRATION_INPUT);
  const codes = new Set(result.conflicts.map((item) => item.code));

  assert.equal(result.ok, false);
  for (const code of [
    'LEGACY_SUPERVISOR_COUNT',
    'ORPHAN_TICKET_COMMUNITY',
    'ACTIVE_TENANT_OWNER_MISSING',
    'INVALID_STAFF_LIMIT',
  ]) assert.equal(codes.has(code), true, code);
  assert.deepEqual(Buffer.from(db.export()), before);
});

test('inspect reports tenant-unique collisions before apply', async (t) => {
  const db = await legacyFixture();
  t.after(() => db.close());
  db.run(`INSERT INTO tenants(id,name,status,owner_user_id,staff_limit,created_at,updated_at)
    VALUES('tenant-test','已有测试企业','active',1,4,'old','old')`);
  db.run(`UPDATE users SET tenant_id='tenant-test' WHERE id=1`);
  db.run(`UPDATE staff_profiles SET tenant_id='tenant-test' WHERE id=101`);
  db.run(`INSERT INTO staff_status(tenant_id,name,status) VALUES
    ('tenant-test','同名状态','on'),('','同名状态','on')`);

  const result = inspectTenantMigration(db, MIGRATION_INPUT);

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((item) => item.code === 'TENANT_UNIQUE_COLLISION'));

  const SQL = await initSqlJs();
  const nullable = new SQL.Database();
  t.after(() => nullable.close());
  nullable.run(`CREATE TABLE tenants (
    id TEXT PRIMARY KEY,name TEXT,status TEXT,owner_user_id INTEGER,staff_limit REAL
  )`);
  nullable.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,phone TEXT,role TEXT,status TEXT,tenant_id TEXT
  )`);
  nullable.run(`CREATE TABLE tenant_settings (tenant_id TEXT,key TEXT)`);
  nullable.run(`INSERT INTO tenants VALUES('tenant-test','test','active',1,4)`);
  nullable.run(`INSERT INTO users VALUES(1,'13800000001','主管','active','tenant-test')`);
  nullable.run(`INSERT INTO tenant_settings VALUES(NULL,'same'),('tenant-test','same')`);
  assert.ok(inspectTenantMigration(nullable, MIGRATION_INPUT).conflicts
    .some((item) => item.code === 'TENANT_UNIQUE_COLLISION'));
});

test('conflicts and mid-migration failures roll back with a stable error code', async (t) => {
  const conflictDb = await legacyFixture();
  const failingDb = await legacyFixture();
  t.after(() => conflictDb.close());
  t.after(() => failingDb.close());
  conflictDb.run(`INSERT INTO users(phone,password,name,role,status,tenant_id)
    VALUES('13900000000','x','另一主管','主管','active','')`);
  assert.throws(
    () => applyTenantMigration(conflictDb, MIGRATION_INPUT),
    (error) => error.code === 'TENANT_MIGRATION_CONFLICT'
  );
  assert.equal(one(conflictDb, 'SELECT COUNT(*) AS count FROM tenants').count, 0);

  failingDb.run(`CREATE TRIGGER reject_ticket_tenant
    BEFORE UPDATE OF tenant_id ON tickets
    WHEN OLD.tenant_id = ''
    BEGIN SELECT RAISE(ABORT, 'blocked migration'); END`);
  assert.throws(
    () => applyTenantMigration(failingDb, MIGRATION_INPUT),
    (error) => error.code === 'TENANT_MIGRATION_CONFLICT'
  );
  assert.equal(one(failingDb, 'SELECT COUNT(*) AS count FROM tenants').count, 0);
  assert.equal(one(failingDb, "SELECT COUNT(*) AS count FROM users WHERE tenant_id='' ").count, 2);
  assert.equal(one(failingDb, "SELECT COUNT(*) AS count FROM tickets WHERE tenant_id='' ").count, 2);
});

test('integrity validation detects cross-tenant core references, not only empty counts', async (t) => {
  const db = await legacyFixture();
  t.after(() => db.close());
  applyTenantMigration(db, MIGRATION_INPUT);
  db.run(`INSERT INTO tenants(id,name,status,owner_user_id,staff_limit,created_at,updated_at)
    VALUES('tenant-other','其他企业','disabled',NULL,4,'old','old')`);
  db.run(`UPDATE community_memberships SET tenant_id='tenant-other'
    WHERE community_id='legacy-community'`);
  db.run(`UPDATE tickets SET assignee_user_id=1 WHERE id='REAL-HISTORY-1'`);

  const integrity = assertTenantIntegrity(db);

  assert.equal(integrity.ok, false);
  assert.ok(integrity.conflicts.some((item) => item.code === 'CROSS_TENANT_MEMBERSHIP'));
  assert.ok(integrity.conflicts.some((item) => item.code === 'TICKET_ASSIGNEE_IDENTITY_MISMATCH'));
});

test('integrity validation covers remaining tenant-owned relationship tables', async (t) => {
  const db = await legacyFixture();
  t.after(() => db.close());
  applyTenantMigration(db, MIGRATION_INPUT);
  db.run(`INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at)
    VALUES('tenant-other','其他企业','disabled',4,'old','old')`);
  db.run(`INSERT INTO staff_profiles(id,tenant_id,name) VALUES(103,'tenant-other','其他主管')`);
  db.run(`UPDATE staff_profiles SET manager_id=103 WHERE id=102`);
  db.run(`INSERT INTO invite_codes(code,community_id,created,tenant_id)
    VALUES('INVITE-X','legacy-community','old','tenant-other')`);
  db.run(`INSERT INTO pending_registrations
    (phone,password,name,role,community_id,status,created,tenant_id)
    VALUES('13000000000','x','待注册','worker','legacy-community','pending','old','tenant-other')`);
  db.run(`UPDATE shift_templates SET tenant_id='tenant-other' WHERE id=201`);
  db.run(`INSERT INTO attendance_change_logs
    (tenant_id,attendance_id,reason) VALUES('tenant-other',401,'cross')`);
  db.run(`INSERT INTO ticket_activity_logs
    (tenant_id,ticket_id,actor_user_id,actor_staff_id,action)
    VALUES('tenant-other','REAL-HISTORY-1',2,102,'cross')`);
  db.run(`INSERT INTO ai_report_analyses (
    tenant_id,staff_profile_id,community_id,range_from,range_to,report_hash,
    model,prompt_version,analysis_json,created_at
  ) VALUES ('tenant-other',102,'legacy-community','a','b','hash','model','v1','{}','old')`);

  const codes = new Set(assertTenantIntegrity(db).conflicts.map((item) => item.code));
  for (const code of [
    'CROSS_TENANT_PROFILE_MANAGER',
    'CROSS_TENANT_INVITE_COMMUNITY',
    'CROSS_TENANT_REGISTRATION_COMMUNITY',
    'CROSS_TENANT_SHIFT_TEMPLATE',
    'CROSS_TENANT_ATTENDANCE_CHANGE',
    'CROSS_TENANT_TICKET_ACTIVITY',
    'CROSS_TENANT_AI_REPORT',
  ]) assert.equal(codes.has(code), true, code);
});

test('production startup gate blocks legacy business data but allows a fully empty install', async (t) => {
  const fresh = await createFullTestDB();
  const legacy = await legacyFixture();
  t.after(() => fresh.close());
  t.after(() => legacy.close());

  assert.doesNotThrow(() => database.assertProductionTenantMigrationReady(fresh, {
    NODE_ENV: 'production',
  }));
  assert.throws(
    () => database.assertProductionTenantMigrationReady(legacy, { NODE_ENV: 'production' }),
    (error) => error.code === 'TENANT_MIGRATION_REQUIRED'
  );
  assert.doesNotThrow(() => database.assertProductionTenantMigrationReady(legacy, {
    NODE_ENV: 'test',
  }));
});

test('file dry-run leaves source bytes unchanged and returns a sanitized report', async (t) => {
  const { directory, source } = await writeLegacyDatabase();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const before = fs.readFileSync(source);

  const result = await migrateMultiTenantFile({
    source,
    apply: false,
    ...MIGRATION_INPUT,
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.backupPath, null);
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(result.report.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|password|hash|token/i);
});

test('file migration upgrades a pre-tenant schema in memory before inspect and apply', async (t) => {
  const { directory, source } = await writePreTenantDatabase();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const before = fs.readFileSync(source);

  const preview = await migrateMultiTenantFile({ source, apply: false, ...MIGRATION_INPUT });
  assert.equal(preview.report.ok, true);
  assert.ok(preview.report.emptyTenantRows.some((item) => item.table === 'users'));
  assert.deepEqual(fs.readFileSync(source), before);

  await migrateMultiTenantFile({
    source, apply: true, confirm: CONFIRM_PHRASE, ...MIGRATION_INPUT,
  });
  const SQL = await initSqlJs();
  const migrated = new SQL.Database(fs.readFileSync(source));
  t.after(() => migrated.close());
  assert.equal(one(migrated, "SELECT tenant_id FROM tickets WHERE id='RAW-LEGACY'").tenant_id,
    'tenant-test');
  assert.equal(assertTenantIntegrity(migrated).ok, true);
});

test('file apply requires an absolute safe path and exact confirmation phrase', async () => {
  await assert.rejects(migrateMultiTenantFile({
    source: 'candidate.db', apply: true, confirm: CONFIRM_PHRASE, ...MIGRATION_INPUT,
  }), /absolute|\u7edd对路径/i);
  await assert.rejects(migrateMultiTenantFile({
    source: '/tmp/missing-tenant.db', apply: true, confirm: '', ...MIGRATION_INPUT,
  }), /MIGRATE-MULTI-TENANT/);
  await assert.rejects(migrateMultiTenantFile({
    source: path.resolve('data.db'), apply: true, confirm: CONFIRM_PHRASE, ...MIGRATION_INPUT,
  }), /本地开发 data\.db/);
});

test('file apply cannot bypass development database protection through a symlink', async (t) => {
  const directory = fs.mkdtempSync('/tmp/tenant-migration-symlink-');
  const linked = path.join(directory, 'candidate.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.symlinkSync(path.resolve('data.db'), linked);

  await assert.rejects(migrateMultiTenantFile({
    source: linked, apply: true, confirm: CONFIRM_PHRASE, ...MIGRATION_INPUT,
  }), /符号链接|本地开发 data\.db/);
});

test('file apply rejects every source symlink instead of replacing the link itself', async (t) => {
  const { directory, source } = await writeLegacyDatabase();
  const linked = path.join(directory, 'linked.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.symlinkSync(source, linked);

  await assert.rejects(migrateMultiTenantFile({
    source: linked, apply: true, confirm: CONFIRM_PHRASE, ...MIGRATION_INPUT,
  }), /符号链接/);
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
});

test('file apply creates a read-only backup, atomically replaces source, and is idempotent', async (t) => {
  const { directory, source } = await writeLegacyDatabase();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const before = fs.readFileSync(source);
  const options = {
    source,
    apply: true,
    confirm: CONFIRM_PHRASE,
    ...MIGRATION_INPUT,
  };

  const first = await migrateMultiTenantFile(options);
  const firstBytes = fs.readFileSync(source);
  assert.equal(first.mode, 'apply');
  assert.deepEqual(fs.readFileSync(first.backupPath), before);
  assert.notDeepEqual(firstBytes, before);
  assert.equal(fs.statSync(first.backupPath).mode & 0o222, 0);
  assert.equal(fs.existsSync(`${source}.tenant-migration.tmp`), false);

  const SQL = await initSqlJs();
  const firstDb = new SQL.Database(firstBytes);
  const firstCounts = migrationCounts(firstDb);
  firstDb.close();
  const second = await migrateMultiTenantFile(options);
  const migrated = new SQL.Database(fs.readFileSync(source));
  t.after(() => migrated.close());
  assert.equal(one(migrated, "SELECT COUNT(*) AS count FROM tenants WHERE id='tenant-test'").count, 1);
  assert.deepEqual(migrationCounts(migrated), firstCounts);
  assert.equal(second.report.integrity.ok, true);
});

test('package exposes tenant dry-run and confirmed apply commands', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['tenant:dry-run'], 'node scripts/migrate-multi-tenant.js');
  assert.equal(pkg.scripts['tenant:apply'], 'node scripts/migrate-multi-tenant.js --apply');
});
