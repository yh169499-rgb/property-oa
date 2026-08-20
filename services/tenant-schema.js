const TENANT_TABLES = [
  'users',
  'staff_profiles',
  'communities',
  'community_permissions',
  'community_memberships',
  'invite_codes',
  'pending_registrations',
  'tickets',
  'staff_status',
  'shift_templates',
  'shift_assignments',
  'attendance_records',
  'attendance_change_logs',
  'tenant_settings',
  'ticket_activity_logs',
  'workforce_import_batches',
  'performance_rule_versions',
  'ai_report_analyses',
  'staff_lifecycle_audit',
];

function values(db, sql, params = []) {
  const result = db.exec(sql, params);
  return result[0] ? result[0].values : [];
}

function tableExists(db, table) {
  return values(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    [table]
  ).length > 0;
}

function columnNames(db, table) {
  return values(db, `PRAGMA table_info(${table})`).map((row) => row[1]);
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!columnNames(db, table).includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function uniqueIndexColumns(db, table) {
  return values(db, `PRAGMA index_list(${table})`)
    .filter((row) => row[2] === 1)
    .map((row) => values(db, `PRAGMA index_info(${JSON.stringify(row[1])})`).map((column) => column[2]));
}

function hasExactUnique(db, table, columns) {
  return uniqueIndexColumns(db, table).some((current) => (
    current.length === columns.length
      && current.every((column, index) => column === columns[index])
  ));
}

function rebuildStaffStatus(db) {
  if (!tableExists(db, 'staff_status')) return;
  const currentColumns = columnNames(db, 'staff_status');
  const tenantNameUnique = hasExactUnique(db, 'staff_status', ['tenant_id', 'name']);
  const globalNameUnique = uniqueIndexColumns(db, 'staff_status')
    .some((columns) => columns.length === 1 && columns[0] === 'name');
  if (currentColumns.includes('tenant_id') && tenantNameUnique && !globalNameUnique) return;

  const beforeCount = Number(values(db, 'SELECT COUNT(*) FROM staff_status')[0][0]);
  db.run('ALTER TABLE staff_status RENAME TO staff_status_legacy_tenant_upgrade');
  db.run(`CREATE TABLE staff_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'on',
    updated TEXT,
    UNIQUE (tenant_id, name)
  )`);
  const tenantExpression = currentColumns.includes('tenant_id') ? "COALESCE(tenant_id, '')" : "''";
  db.run(`INSERT INTO staff_status (tenant_id, name, status, updated)
    SELECT ${tenantExpression}, name, status, updated
    FROM staff_status_legacy_tenant_upgrade`);
  const afterCount = Number(values(db, 'SELECT COUNT(*) FROM staff_status')[0][0]);
  if (afterCount !== beforeCount) throw new Error('staff_status tenant upgrade row count mismatch');
  db.run('DROP TABLE staff_status_legacy_tenant_upgrade');
}

function rebuildPerformanceRules(db) {
  if (!tableExists(db, 'performance_rule_versions')) return;
  const currentColumns = columnNames(db, 'performance_rule_versions');
  const tenantVersionUnique = hasExactUnique(db, 'performance_rule_versions', ['tenant_id', 'version_no']);
  const globalVersionUnique = uniqueIndexColumns(db, 'performance_rule_versions')
    .some((columns) => columns.length === 1 && columns[0] === 'version_no');
  if (currentColumns.includes('tenant_id') && tenantVersionUnique && !globalVersionUnique) return;

  const beforeCount = Number(values(db, 'SELECT COUNT(*) FROM performance_rule_versions')[0][0]);
  db.run('ALTER TABLE performance_rule_versions RENAME TO performance_rule_versions_legacy_tenant_upgrade');
  db.run(`CREATE TABLE performance_rule_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT '',
    version_no INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    completion_weight REAL NOT NULL,
    on_time_weight REAL NOT NULL,
    quality_weight REAL NOT NULL,
    excellent_threshold REAL NOT NULL,
    good_threshold REAL NOT NULL,
    qualified_threshold REAL NOT NULL,
    minimum_sample_size INTEGER NOT NULL,
    effective_at TEXT NOT NULL,
    created_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    UNIQUE (tenant_id, version_no),
    CHECK (completion_weight >= 0 AND completion_weight <= 100),
    CHECK (on_time_weight >= 0 AND on_time_weight <= 100),
    CHECK (quality_weight >= 0 AND quality_weight <= 100),
    CHECK (completion_weight + on_time_weight + quality_weight = 100),
    CHECK (excellent_threshold <= 100 AND excellent_threshold > good_threshold),
    CHECK (good_threshold > qualified_threshold AND qualified_threshold >= 0),
    CHECK (minimum_sample_size >= 0)
  )`);
  const tenantExpression = currentColumns.includes('tenant_id') ? "COALESCE(tenant_id, '')" : "''";
  db.run(`INSERT INTO performance_rule_versions (
    id, tenant_id, version_no, name, completion_weight, on_time_weight,
    quality_weight, excellent_threshold, good_threshold, qualified_threshold,
    minimum_sample_size, effective_at, created_by_user_id, created_at, is_active
  ) SELECT
    id, ${tenantExpression}, version_no, name, completion_weight, on_time_weight,
    quality_weight, excellent_threshold, good_threshold, qualified_threshold,
    minimum_sample_size, effective_at, created_by_user_id, created_at, is_active
  FROM performance_rule_versions_legacy_tenant_upgrade`);
  const afterCount = Number(values(db, 'SELECT COUNT(*) FROM performance_rule_versions')[0][0]);
  if (afterCount !== beforeCount) throw new Error('performance rule tenant upgrade row count mismatch');
  db.run('DROP TABLE performance_rule_versions_legacy_tenant_upgrade');
}

function rebuildTenantUniqueTable(db, definition) {
  if (!tableExists(db, definition.table)) return;
  const uniques = uniqueIndexColumns(db, definition.table);
  const hasTenantUnique = uniques.some((columns) => (
    columns.length === definition.tenantUnique.length
      && columns.every((column, index) => column === definition.tenantUnique[index])
  ));
  const hasLegacyUnique = uniques.some((columns) => (
    columns.length === definition.legacyUnique.length
      && columns.every((column, index) => column === definition.legacyUnique[index])
  ));
  if (hasTenantUnique && !hasLegacyUnique) return;

  const legacyTable = `${definition.table}_legacy_tenant_upgrade`;
  const beforeCount = Number(values(db, `SELECT COUNT(*) FROM ${definition.table}`)[0][0]);
  db.run(`ALTER TABLE ${definition.table} RENAME TO ${legacyTable}`);
  db.run(definition.createSql);
  db.run(`INSERT INTO ${definition.table} (${definition.columns.join(', ')})
    SELECT ${definition.columns.join(', ')} FROM ${legacyTable}`);
  const afterCount = Number(values(db, `SELECT COUNT(*) FROM ${definition.table}`)[0][0]);
  if (afterCount !== beforeCount) {
    throw new Error(`${definition.table} tenant upgrade row count mismatch`);
  }
  db.run(`DROP TABLE ${legacyTable}`);
}

function rebuildWorkforceTenantUniques(db) {
  const definitions = [
    {
      table: 'shift_assignments',
      legacyUnique: ['staff_id', 'work_date'],
      tenantUnique: ['tenant_id', 'staff_id', 'work_date'],
      columns: [
        'id', 'tenant_id', 'staff_id', 'work_date', 'assignment_type',
        'template_id', 'start_at', 'end_at', 'leave_type', 'note',
        'created_by', 'updated_at',
      ],
      createSql: `CREATE TABLE shift_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT '',
        staff_id INTEGER,
        work_date TEXT,
        assignment_type TEXT DEFAULT 'work',
        template_id INTEGER,
        start_at TEXT,
        end_at TEXT,
        leave_type TEXT,
        note TEXT DEFAULT '',
        created_by INTEGER,
        updated_at TEXT DEFAULT '',
        UNIQUE (tenant_id, staff_id, work_date)
      )`,
    },
    {
      table: 'attendance_records',
      legacyUnique: ['staff_id', 'work_date'],
      tenantUnique: ['tenant_id', 'staff_id', 'work_date'],
      columns: [
        'id', 'tenant_id', 'staff_id', 'shift_assignment_id', 'work_date',
        'check_in_at', 'check_out_at', 'status', 'is_corrected', 'updated_at',
      ],
      createSql: `CREATE TABLE attendance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT '',
        staff_id INTEGER,
        shift_assignment_id INTEGER,
        work_date TEXT,
        check_in_at TEXT,
        check_out_at TEXT,
        status TEXT DEFAULT 'not_started',
        is_corrected INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT '',
        UNIQUE (tenant_id, staff_id, work_date)
      )`,
    },
    {
      table: 'workforce_import_batches',
      legacyUnique: ['import_key'],
      tenantUnique: ['tenant_id', 'import_key'],
      columns: [
        'id', 'tenant_id', 'import_key', 'imported_by', 'imported_at', 'summary_json',
      ],
      createSql: `CREATE TABLE workforce_import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT '',
        import_key TEXT NOT NULL,
        imported_by INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        summary_json TEXT DEFAULT '{}',
        UNIQUE (tenant_id, import_key)
      )`,
    },
    {
      table: 'community_memberships',
      legacyUnique: ['community_id', 'staff_profile_id'],
      tenantUnique: ['tenant_id', 'community_id', 'staff_profile_id'],
      columns: [
        'tenant_id', 'community_id', 'staff_profile_id', 'created_at',
        'created_by_user_id',
      ],
      createSql: `CREATE TABLE community_memberships (
        tenant_id TEXT NOT NULL DEFAULT '',
        community_id TEXT NOT NULL,
        staff_profile_id INTEGER NOT NULL,
        created_at TEXT DEFAULT '',
        created_by_user_id INTEGER,
        UNIQUE (tenant_id, community_id, staff_profile_id)
      )`,
    },
  ];
  for (const definition of definitions) rebuildTenantUniqueTable(db, definition);
}

function ensureTenantSchema(db) {
  db.run('SAVEPOINT ensure_tenant_schema');
  try {
    db.run(`CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      owner_user_id INTEGER,
      staff_limit INTEGER NOT NULL DEFAULT 4 CHECK (staff_limit BETWEEN 1 AND 999 AND staff_limit = CAST(staff_limit AS INTEGER)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT NOT NULL DEFAULT ''
    )`);
    addColumn(db, 'tenants', 'owner_user_id INTEGER');
    addColumn(db, 'tenants', `staff_limit INTEGER NOT NULL DEFAULT 4
      CHECK (staff_limit BETWEEN 1 AND 999 AND staff_limit = CAST(staff_limit AS INTEGER))`);
    addColumn(db, 'tenants', "disabled_at TEXT NOT NULL DEFAULT ''");

    db.run(`CREATE TABLE IF NOT EXISTS enterprise_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enterprise_name TEXT NOT NULL,
      supervisor_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      rejection_reason TEXT NOT NULL DEFAULT '',
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    )`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_enterprise_phone
      ON enterprise_applications(phone) WHERE status = 'pending'`);

    db.run(`CREATE TABLE IF NOT EXISTS platform_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      before_json TEXT NOT NULL DEFAULT '{}',
      after_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tenant_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE (tenant_id, key)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS staff_lifecycle_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT '',
      actor_user_id INTEGER NOT NULL,
      target_user_id INTEGER NOT NULL,
      target_staff_profile_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_staff_lifecycle_target
      ON staff_lifecycle_audit(target_user_id, action)`);

    for (const table of TENANT_TABLES) {
      if (
        tableExists(db, table)
        && table !== 'users'
        && table !== 'staff_status'
        && table !== 'performance_rule_versions'
      ) {
        addColumn(db, table, "tenant_id TEXT DEFAULT ''");
      }
    }
    addColumn(db, 'users', 'tenant_id TEXT');
    addColumn(db, 'users', 'session_version INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'users', 'last_login_at TEXT');

    rebuildStaffStatus(db);
    rebuildPerformanceRules(db);
    rebuildWorkforceTenantUniques(db);

    db.run('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone)');
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_platform_owner
      ON users(role) WHERE role = 'platform_owner' AND status = 'active'`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_tenant_supervisor
      ON users(tenant_id) WHERE role = '主管' AND status = 'active'
        AND tenant_id IS NOT NULL AND tenant_id <> ''`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_owner
      ON tenants(owner_user_id) WHERE owner_user_id IS NOT NULL`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_status_tenant_name
      ON staff_status(tenant_id, name)`);
    if (tableExists(db, 'performance_rule_versions')) {
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_performance_tenant_version
        ON performance_rule_versions(tenant_id, version_no)`);
    }
    if (tableExists(db, 'shift_assignments')) {
      db.run('CREATE INDEX IF NOT EXISTS idx_shift_staff_date ON shift_assignments(staff_id, work_date)');
    }
    if (tableExists(db, 'attendance_records')) {
      db.run('CREATE INDEX IF NOT EXISTS idx_attendance_staff_date ON attendance_records(staff_id, work_date)');
    }

    for (const table of TENANT_TABLES) {
      if (tableExists(db, table)) {
        db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`);
      }
    }
    db.run('RELEASE SAVEPOINT ensure_tenant_schema');
  } catch (error) {
    try {
      db.run('ROLLBACK TO SAVEPOINT ensure_tenant_schema');
      db.run('RELEASE SAVEPOINT ensure_tenant_schema');
    } catch (_) {}
    throw error;
  }
}

module.exports = { ensureTenantSchema, TENANT_TABLES, tableExists };
