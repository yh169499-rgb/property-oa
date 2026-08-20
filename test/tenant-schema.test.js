const assert = require('node:assert/strict');
const test = require('node:test');
const initSqlJs = require('sql.js');

const database = require('../db');
const { ensureCoreSchema } = require('../services/core-schema');
const { ensureWorkforceSchema } = require('../workforce-schema');
const {
  ensureTenantSchema,
  TENANT_TABLES,
} = require('../services/tenant-schema');
const {
  createFullTestDB,
  one,
  rows,
  tableNames,
  columnNames,
  indexNames,
} = require('./helpers/tenant-fixture');

test('full fixture creates every tenant schema table and column', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  for (const table of [
    'tenants',
    'enterprise_applications',
    'platform_audit_logs',
    'tenant_settings',
  ]) {
    assert.ok(tableNames(db).includes(table), `missing table: ${table}`);
  }

  for (const table of TENANT_TABLES) {
    assert.ok(tableNames(db).includes(table), `missing tenant table: ${table}`);
    assert.ok(columnNames(db, table).includes('tenant_id'), `${table}.tenant_id`);
  }

  assert.deepEqual(
    ['tenant_id', 'session_version', 'last_login_at'].map((name) => columnNames(db, 'users').includes(name)),
    [true, true, true]
  );
  assert.equal(one(db, "SELECT dflt_value AS value FROM pragma_table_info('users') WHERE name='session_version'").value, '0');

  const applicationColumns = columnNames(db, 'enterprise_applications');
  assert.ok(applicationColumns.includes('password_hash'));
  assert.equal(applicationColumns.includes('password'), false, 'plaintext password column must not exist');
  for (const column of ['reviewed_by_user_id', 'reviewed_at', 'rejection_reason', 'created_at', 'updated_at']) {
    assert.ok(applicationColumns.includes(column), `enterprise_applications.${column}`);
  }

  for (const column of ['actor_user_id', 'action', 'target_type', 'target_id', 'before_json', 'after_json', 'created_at']) {
    assert.ok(columnNames(db, 'platform_audit_logs').includes(column), `platform_audit_logs.${column}`);
  }
  assert.deepEqual(
    ['tenant_id', 'key', 'value', 'created_at', 'updated_at'].map((name) => columnNames(db, 'tenant_settings').includes(name)),
    [true, true, true, true, true]
  );
});

test('tenant staff limit defaults to four and only accepts 1 through 999', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  db.run("INSERT INTO tenants(id,name,status,created_at,updated_at) VALUES('default-limit','默认上限','active','now','now')");
  assert.equal(one(db, "SELECT staff_limit FROM tenants WHERE id='default-limit'").staff_limit, 4);

  db.run("INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at) VALUES('min-limit','最小上限','active',1,'now','now')");
  db.run("INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at) VALUES('max-limit','最大上限','active',999,'now','now')");
  for (const invalid of [0, 1000, 1.5]) {
    assert.throws(
      () => db.run('INSERT INTO tenants(id,name,status,staff_limit,created_at,updated_at) VALUES(?,?,?,?,?,?)', [
        `invalid-${invalid}`, '错误上限', 'active', invalid, 'now', 'now',
      ]),
      /CHECK constraint failed/
    );
  }
});

test('tenant settings keys are unique inside a tenant only', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  db.run("INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at) VALUES('a','sla','10','now','now')");
  db.run("INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at) VALUES('b','sla','20','now','now')");
  assert.throws(
    () => db.run("INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at) VALUES('a','sla','30','now','now')"),
    /UNIQUE constraint failed/
  );
});

test('account uniqueness rules allow one active owner and one active supervisor per tenant', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  db.run(`INSERT INTO users(phone,password,name,role,status,tenant_id) VALUES
    ('13000000001','hash','平台一','platform_owner','active',NULL),
    ('13000000002','hash','停用平台','platform_owner','disabled',NULL),
    ('13000000003','hash','甲主管','主管','active','tenant-a'),
    ('13000000004','hash','乙主管','主管','active','tenant-b'),
    ('13000000005','hash','甲旧主管','主管','disabled','tenant-a')`);
  db.run("INSERT INTO users(phone,password,name,role,status) VALUES('13000000008','hash','未绑定平台','platform_owner','disabled')");
  assert.equal(one(db, "SELECT tenant_id FROM users WHERE phone='13000000008'").tenant_id, null);
  assert.throws(
    () => db.run("INSERT INTO users(phone,password,name,role,status) VALUES('13000000006','hash','平台二','platform_owner','active')"),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => db.run("INSERT INTO users(phone,password,name,role,status,tenant_id) VALUES('13000000007','hash','甲主管二','主管','active','tenant-a')"),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => db.run("INSERT INTO users(phone,password,name,role,status,tenant_id) VALUES('13000000001','hash','重号','worker','active','tenant-b')"),
    /UNIQUE constraint failed/
  );

  db.run("INSERT INTO tenants(id,name,status,owner_user_id,created_at,updated_at) VALUES('tenant-a','甲企业','active',1,'now','now')");
  assert.throws(
    () => db.run("INSERT INTO tenants(id,name,status,owner_user_id,created_at,updated_at) VALUES('tenant-b','乙企业','active',1,'now','now')"),
    /UNIQUE constraint failed/
  );

  for (const name of ['uq_active_platform_owner', 'uq_active_tenant_supervisor', 'uq_tenant_owner', 'uq_users_phone']) {
    assert.ok(indexNames(db).includes(name), `missing index: ${name}`);
  }
});

test('tenant query indexes cover every existing tenant business table', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  for (const table of TENANT_TABLES) {
    if (!tableNames(db).includes(table)) continue;
    const tenantIndexes = rows(db, `PRAGMA index_list(${table})`)
      .filter((index) => rows(db, `PRAGMA index_info(${JSON.stringify(index.name)})`)[0]?.name === 'tenant_id');
    assert.ok(tenantIndexes.length > 0, `missing tenant-leading index: ${table}`);
  }
});

test('legacy staff status table is rebuilt with tenant name uniqueness and keeps rows', async (t) => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  t.after(() => db.close());
  ensureCoreSchema(db);
  db.run("INSERT INTO staff_status(name,status,updated) VALUES('张三','off','yesterday')");

  ensureTenantSchema(db);

  assert.deepEqual(one(db, "SELECT tenant_id,name,status,updated FROM staff_status WHERE name='张三'"), {
    tenant_id: '', name: '张三', status: 'off', updated: 'yesterday',
  });
  db.run("INSERT INTO staff_status(tenant_id,name,status) VALUES('tenant-a','张三','on')");
  db.run("INSERT INTO staff_status(tenant_id,name,status) VALUES('tenant-b','张三','on')");
  assert.throws(
    () => db.run("INSERT INTO staff_status(tenant_id,name,status) VALUES('tenant-a','张三','off')"),
    /UNIQUE constraint failed/
  );
  assert.equal(one(db, "SELECT COUNT(*) AS count FROM staff_status WHERE name='张三'").count, 3);
});

test('legacy performance versions are rebuilt with tenant uniqueness and keep all data', async (t) => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  t.after(() => db.close());
  ensureCoreSchema(db);
  ensureWorkforceSchema(db);
  db.run(`INSERT INTO performance_rule_versions (
    version_no,name,completion_weight,on_time_weight,quality_weight,
    excellent_threshold,good_threshold,qualified_threshold,minimum_sample_size,
    effective_at,created_at,is_active
  ) VALUES (2,'旧规则',30,50,20,90,80,60,1,'then','then',0)`);

  ensureTenantSchema(db);

  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM performance_rule_versions').count, 2);
  assert.equal(one(db, "SELECT name FROM performance_rule_versions WHERE version_no=2").name, '旧规则');
  db.run(`INSERT INTO performance_rule_versions (
    tenant_id,version_no,name,completion_weight,on_time_weight,quality_weight,
    excellent_threshold,good_threshold,qualified_threshold,minimum_sample_size,
    effective_at,created_at,is_active
  ) VALUES ('tenant-a',2,'甲规则',30,50,20,90,80,60,1,'now','now',0)`);
  db.run(`INSERT INTO performance_rule_versions (
    tenant_id,version_no,name,completion_weight,on_time_weight,quality_weight,
    excellent_threshold,good_threshold,qualified_threshold,minimum_sample_size,
    effective_at,created_at,is_active
  ) VALUES ('tenant-b',2,'乙规则',30,50,20,90,80,60,1,'now','now',0)`);
  assert.throws(() => db.run(`INSERT INTO performance_rule_versions (
    tenant_id,version_no,name,completion_weight,on_time_weight,quality_weight,
    excellent_threshold,good_threshold,qualified_threshold,minimum_sample_size,
    effective_at,created_at,is_active
  ) VALUES ('tenant-a',2,'甲重复',30,50,20,90,80,60,1,'now','now',0)`), /UNIQUE constraint failed/);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM performance_rule_versions WHERE version_no=2').count, 3);
});

test('legacy workforce unique constraints upgrade to tenant-level uniqueness without data loss', async (t) => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  t.after(() => db.close());
  ensureCoreSchema(db);
  db.run(`
    CREATE TABLE shift_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, work_date TEXT,
      assignment_type TEXT DEFAULT 'work', template_id INTEGER, start_at TEXT,
      end_at TEXT, leave_type TEXT, note TEXT DEFAULT '', created_by INTEGER,
      updated_at TEXT DEFAULT '', UNIQUE (staff_id, work_date)
    );
    CREATE TABLE attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER,
      shift_assignment_id INTEGER, work_date TEXT, check_in_at TEXT,
      check_out_at TEXT, status TEXT DEFAULT 'not_started',
      is_corrected INTEGER DEFAULT 0, updated_at TEXT DEFAULT '',
      UNIQUE (staff_id, work_date)
    );
    CREATE TABLE workforce_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, import_key TEXT UNIQUE NOT NULL,
      imported_by INTEGER NOT NULL, imported_at TEXT NOT NULL,
      summary_json TEXT DEFAULT '{}'
    );
    CREATE TABLE community_memberships (
      community_id TEXT NOT NULL, staff_profile_id INTEGER NOT NULL,
      created_at TEXT DEFAULT '', created_by_user_id INTEGER,
      UNIQUE (community_id, staff_profile_id)
    );
    INSERT INTO shift_assignments(staff_id,work_date,note) VALUES(7,'2026-08-20','保留排班');
    INSERT INTO attendance_records(staff_id,work_date,status) VALUES(7,'2026-08-20','done');
    INSERT INTO workforce_import_batches(import_key,imported_by,imported_at,summary_json)
      VALUES('same-key',1,'then','{"kept":true}');
    INSERT INTO community_memberships(community_id,staff_profile_id,created_at)
      VALUES('same-community',7,'then');
  `);

  ensureTenantSchema(db);

  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM shift_assignments').count, 1);
  assert.equal(one(db, 'SELECT note FROM shift_assignments WHERE id=1').note, '保留排班');
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM attendance_records').count, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM workforce_import_batches').count, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM community_memberships').count, 1);

  db.run("INSERT INTO shift_assignments(tenant_id,staff_id,work_date) VALUES('tenant-a',7,'2026-08-20')");
  db.run("INSERT INTO shift_assignments(tenant_id,staff_id,work_date) VALUES('tenant-b',7,'2026-08-20')");
  db.run("INSERT INTO attendance_records(tenant_id,staff_id,work_date) VALUES('tenant-a',7,'2026-08-20')");
  db.run("INSERT INTO attendance_records(tenant_id,staff_id,work_date) VALUES('tenant-b',7,'2026-08-20')");
  db.run("INSERT INTO workforce_import_batches(tenant_id,import_key,imported_by,imported_at) VALUES('tenant-a','same-key',1,'now')");
  db.run("INSERT INTO workforce_import_batches(tenant_id,import_key,imported_by,imported_at) VALUES('tenant-b','same-key',1,'now')");
  db.run("INSERT INTO community_memberships(tenant_id,community_id,staff_profile_id) VALUES('tenant-a','same-community',7)");
  db.run("INSERT INTO community_memberships(tenant_id,community_id,staff_profile_id) VALUES('tenant-b','same-community',7)");

  assert.throws(
    () => db.run("INSERT INTO workforce_import_batches(tenant_id,import_key,imported_by,imported_at) VALUES('tenant-a','same-key',1,'again')"),
    /UNIQUE constraint failed/
  );
});

test('schema initialization is idempotent and does not duplicate seeded rows', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  const before = Object.fromEntries(tableNames(db).map((table) => [
    table,
    one(db, `SELECT COUNT(*) AS count FROM ${table}`).count,
  ]));

  ensureCoreSchema(db);
  ensureWorkforceSchema(db);
  ensureTenantSchema(db);
  ensureCoreSchema(db);
  ensureWorkforceSchema(db);
  ensureTenantSchema(db);

  const after = Object.fromEntries(tableNames(db).map((table) => [
    table,
    one(db, `SELECT COUNT(*) AS count FROM ${table}`).count,
  ]));
  assert.deepEqual(after, before);
});

test('tenant schema changes roll back together when an upgrade fails', async (t) => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  t.after(() => db.close());
  ensureCoreSchema(db);
  db.run('CREATE TABLE enterprise_applications (id INTEGER PRIMARY KEY, phone TEXT)');

  assert.throws(() => ensureTenantSchema(db));
  assert.equal(tableNames(db).includes('tenants'), false);
  assert.equal(columnNames(db, 'users').includes('tenant_id'), false);
});

test('database schema initialization rolls back core and workforce changes on any error', async (t) => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  t.after(() => db.close());
  db.run('CREATE TABLE enterprise_applications (id INTEGER PRIMARY KEY, phone TEXT)');

  assert.equal(typeof database.ensureDatabaseSchema, 'function');
  assert.throws(() => database.ensureDatabaseSchema(db));
  assert.equal(tableNames(db).includes('tickets'), false);
  assert.equal(tableNames(db).includes('staff_profiles'), false);
  assert.equal(tableNames(db).includes('tenants'), false);
  assert.deepEqual(tableNames(db), ['enterprise_applications']);
});

test('core schema initialization no longer creates a global default community', async (t) => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  t.after(() => db.close());

  ensureCoreSchema(db);
  ensureWorkforceSchema(db);
  ensureTenantSchema(db);

  assert.equal(one(db, "SELECT id FROM communities WHERE id='default'"), null);
  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM communities').count, 0);
});
