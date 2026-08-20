function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  const result = db.exec(`PRAGMA table_info(${table})`);
  const existing = result[0] ? result[0].values.map((row) => row[1]) : [];

  if (!existing.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function tableExists(db, table) {
  const result = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table]
  );
  return Boolean(result[0] && result[0].values.length);
}

function hasColumn(db, table, column) {
  if (!tableExists(db, table)) return false;
  const result = db.exec(`PRAGMA table_info(${table})`);
  return Boolean(result[0]?.values.some((row) => row[1] === column));
}

function backfillCommunityMemberships(db, nowIso = new Date().toISOString()) {
  const tenantAware = hasColumn(db, 'community_permissions', 'tenant_id')
    && hasColumn(db, 'community_memberships', 'tenant_id')
    && hasColumn(db, 'staff_profiles', 'tenant_id')
    && hasColumn(db, 'communities', 'tenant_id');
  if (tableExists(db, 'community_permissions')) {
    if (tenantAware) {
      db.run(`
        INSERT OR IGNORE INTO community_memberships (
          tenant_id,
          community_id,
          staff_profile_id,
          created_at
        )
        SELECT
          cp.tenant_id,
          cp.community_id,
          MIN(sp.id),
          ?
        FROM community_permissions cp
        JOIN communities c
          ON c.id = cp.community_id
          AND c.tenant_id = cp.tenant_id
        JOIN staff_profiles sp
          ON TRIM(sp.name) = TRIM(cp.staff_name)
          AND sp.tenant_id = cp.tenant_id
        WHERE TRIM(sp.name) <> ''
          AND COALESCE(cp.tenant_id, '') <> ''
        GROUP BY cp.tenant_id, cp.community_id, cp.staff_name
        HAVING COUNT(sp.id) = 1
      `, [nowIso]);
    } else {
      db.run(`
        INSERT OR IGNORE INTO community_memberships (
          community_id,
          staff_profile_id,
          created_at
        )
        SELECT
          cp.community_id,
          MIN(sp.id),
          ?
        FROM community_permissions cp
        JOIN staff_profiles sp
          ON TRIM(sp.name) = TRIM(cp.staff_name)
        WHERE TRIM(sp.name) <> ''
        GROUP BY cp.community_id, cp.staff_name
        HAVING COUNT(sp.id) = 1
      `, [nowIso]);
    }
  }
  // 单小区且没有任何历史授权时，所有在职档案默认属于该唯一小区；
  // 多小区或存在旧授权时不猜测归属，避免越权和串区。
  if (tableExists(db, 'communities') && !tenantAware) {
    const communities = db.exec('SELECT id FROM communities ORDER BY created');
    const communityRows = communities[0] ? communities[0].values : [];
    if (communityRows.length === 1) {
      const communityId = communityRows[0][0];
      const legacyCount = tableExists(db, 'community_permissions')
        ? db.exec('SELECT COUNT(*) FROM community_permissions WHERE community_id = ?', [communityId])[0].values[0][0]
        : 0;
      const membershipCount = db.exec('SELECT COUNT(*) FROM community_memberships WHERE community_id = ?', [communityId])[0].values[0][0];
      if (Number(legacyCount) === 0 && Number(membershipCount) === 0) {
        db.run(`
          INSERT OR IGNORE INTO community_memberships (community_id, staff_profile_id, created_at)
          SELECT ?, id, ? FROM staff_profiles
          WHERE COALESCE(employment_status, 'active') = 'active'
        `, [communityId, nowIso]);
      }
    }
  } else if (tenantAware) {
    const tenants = db.exec(`
      SELECT tenant_id
      FROM communities
      WHERE COALESCE(tenant_id, '') <> ''
      GROUP BY tenant_id
      HAVING COUNT(*) = 1
    `);
    const tenantRows = tenants[0] ? tenants[0].values : [];
    for (const [tenantId] of tenantRows) {
      const communityId = db.exec(
        'SELECT id FROM communities WHERE tenant_id = ?',
        [tenantId]
      )[0].values[0][0];
      const legacyCount = db.exec(
        'SELECT COUNT(*) FROM community_permissions WHERE tenant_id = ?',
        [tenantId]
      )[0].values[0][0];
      const membershipCount = db.exec(
        'SELECT COUNT(*) FROM community_memberships WHERE tenant_id = ?',
        [tenantId]
      )[0].values[0][0];
      if (Number(legacyCount) === 0 && Number(membershipCount) === 0) {
        db.run(`
          INSERT OR IGNORE INTO community_memberships (
            tenant_id, community_id, staff_profile_id, created_at
          )
          SELECT ?, ?, id, ? FROM staff_profiles
          WHERE tenant_id = ?
            AND COALESCE(employment_status, 'active') = 'active'
        `, [tenantId, communityId, nowIso, tenantId]);
      }
    }
  }
}

function backfillDefaultPerformanceRules(db, nowIso = new Date().toISOString()) {
  if (!tableExists(db, 'performance_rule_versions')) return;

  const tenantAware = tableExists(db, 'tenants')
    && hasColumn(db, 'performance_rule_versions', 'tenant_id')
    && (!tableExists(db, 'tickets') || hasColumn(db, 'tickets', 'tenant_id'));
  if (tenantAware) {
    db.run(`
      INSERT INTO performance_rule_versions (
        tenant_id,
        version_no,
        name,
        completion_weight,
        on_time_weight,
        quality_weight,
        excellent_threshold,
        good_threshold,
        qualified_threshold,
        minimum_sample_size,
        effective_at,
        created_at,
        is_active
      )
      SELECT t.id, 1, '默认规则', 30, 50, 20, 90, 80, 60, 1, ?, ?, 1
      FROM tenants t
      WHERE COALESCE(t.id, '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM performance_rule_versions p
          WHERE p.tenant_id = t.id AND p.version_no = 1
        )
    `, [nowIso, nowIso]);

    if (tableExists(db, 'tickets')) {
      db.run(`
        UPDATE tickets
        SET performance_rule_version_id = (
          SELECT p.id FROM performance_rule_versions p
          WHERE p.tenant_id = tickets.tenant_id AND p.version_no = 1
          ORDER BY p.id
          LIMIT 1
        )
        WHERE performance_rule_version_id IS NULL
          AND COALESCE(tenant_id, '') <> ''
          AND EXISTS (
            SELECT 1 FROM performance_rule_versions p
            WHERE p.tenant_id = tickets.tenant_id AND p.version_no = 1
          )
      `);
    }
    return;
  }

  db.run(`
    INSERT INTO performance_rule_versions (
      tenant_id,
      version_no,
      name,
      completion_weight,
      on_time_weight,
      quality_weight,
      excellent_threshold,
      good_threshold,
      qualified_threshold,
      minimum_sample_size,
      effective_at,
      created_at,
      is_active
    ) SELECT '', 1, '默认规则', 30, 50, 20, 90, 80, 60, 1, ?, ?, 1
    WHERE NOT EXISTS (
      SELECT 1 FROM performance_rule_versions
      WHERE tenant_id = '' AND version_no = 1
    )
  `, [nowIso, nowIso]);

  if (tableExists(db, 'tickets')) {
    db.run(`
      UPDATE tickets
      SET performance_rule_version_id = (
        SELECT id FROM performance_rule_versions
        WHERE version_no = 1 AND tenant_id = ''
      )
      WHERE performance_rule_version_id IS NULL
    `);
  }
}

function ensureWorkforceSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS staff_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT '',
      user_id INTEGER UNIQUE,
      name TEXT DEFAULT '',
      birth_month TEXT DEFAULT '',
      join_date TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      position TEXT DEFAULT '',
      skill TEXT DEFAULT '',
      manager_id INTEGER,
      employment_status TEXT DEFAULT 'active',
      departed_at TEXT DEFAULT '',
      departed_by_user_id INTEGER,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      CHECK (manager_id IS NULL OR manager_id <> id)
    )
  `);

  // Existing installations may already have staff_profiles. Keep the migration
  // additive so stable historical identity is available without recreating it.
  addColumn(db, 'staff_profiles', "departed_at TEXT DEFAULT ''");
  addColumn(db, 'staff_profiles', 'departed_by_user_id INTEGER');
  addColumn(db, 'staff_profiles', "tenant_id TEXT NOT NULL DEFAULT ''");

  db.run(`
    CREATE TABLE IF NOT EXISTS shift_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT '',
      name TEXT DEFAULT '',
      start_time TEXT DEFAULT '',
      end_time TEXT DEFAULT '',
      color TEXT DEFAULT '',
      grace_minutes INTEGER DEFAULT 5,
      created_by INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shift_assignments (
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_records (
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT '',
      attendance_id INTEGER,
      operator_user_id INTEGER,
      before_json TEXT DEFAULT '{}',
      after_json TEXT DEFAULT '{}',
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ticket_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT '',
      ticket_id TEXT,
      actor_user_id INTEGER,
      actor_staff_id INTEGER,
      action TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workforce_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT '',
      import_key TEXT NOT NULL,
      imported_by INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      summary_json TEXT DEFAULT '{}',
      UNIQUE (tenant_id, import_key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS performance_rule_versions (
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS community_memberships (
      tenant_id TEXT NOT NULL DEFAULT '',
      community_id TEXT NOT NULL,
      staff_profile_id INTEGER NOT NULL,
      created_at TEXT DEFAULT '',
      created_by_user_id INTEGER,
      UNIQUE (tenant_id, community_id, staff_profile_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_report_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT '',
      staff_profile_id INTEGER NOT NULL,
      community_id TEXT NOT NULL DEFAULT '',
      range_from TEXT NOT NULL,
      range_to TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  for (const table of [
    'shift_templates', 'shift_assignments', 'attendance_records',
    'attendance_change_logs', 'ticket_activity_logs', 'workforce_import_batches',
    'performance_rule_versions', 'community_memberships', 'ai_report_analyses',
  ]) {
    addColumn(db, table, "tenant_id TEXT NOT NULL DEFAULT ''");
  }

  addColumn(db, 'tickets', 'assignee_user_id INTEGER');
  addColumn(db, 'tickets', 'assignee_staff_profile_id INTEGER');
  addColumn(db, 'tickets', "assigned_at TEXT DEFAULT ''");
  addColumn(db, 'tickets', 'performance_rule_version_id INTEGER');

  db.run('CREATE INDEX IF NOT EXISTS idx_staff_manager ON staff_profiles(manager_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_staff_profiles_tenant ON staff_profiles(tenant_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_shift_staff_date ON shift_assignments(staff_id, work_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_attendance_staff_date ON attendance_records(staff_id, work_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ticket_activity_actor_time ON ticket_activity_logs(actor_staff_id, created_at)');
  const ticketColumns = db.exec('PRAGMA table_info(tickets)');
  const ticketColumnNames = ticketColumns[0]
    ? ticketColumns[0].values.map((row) => row[1])
    : [];
  if (ticketColumnNames.includes('created')) {
    const assigneeIndex = db.exec('PRAGMA index_info(idx_tickets_assignee_profile)');
    const assigneeIndexColumns = assigneeIndex[0]
      ? assigneeIndex[0].values.map((row) => row[2])
      : [];
    if (
      assigneeIndexColumns.length > 0
      && (
        assigneeIndexColumns.length !== 2
        || assigneeIndexColumns[0] !== 'assignee_staff_profile_id'
        || assigneeIndexColumns[1] !== 'created'
      )
    ) {
      db.run('DROP INDEX idx_tickets_assignee_profile');
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_assignee_profile
      ON tickets(assignee_staff_profile_id, created)`);
  } else {
    db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_assignee_profile
      ON tickets(assignee_staff_profile_id)`);
  }
  const cacheIndex = db.exec('PRAGMA index_info(uq_ai_report_cache)');
  const cacheIndexColumns = cacheIndex[0]
    ? cacheIndex[0].values.map((row) => row[2])
    : [];
  if (cacheIndexColumns.length > 0 && cacheIndexColumns[0] !== 'tenant_id') {
    db.run('DROP INDEX uq_ai_report_cache');
  }
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_report_cache
    ON ai_report_analyses(tenant_id, report_hash, model, prompt_version)`);
}

module.exports = {
  ensureWorkforceSchema,
  addColumn,
  backfillCommunityMemberships,
  backfillDefaultPerformanceRules,
};
