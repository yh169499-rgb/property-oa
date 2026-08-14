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

function backfillCommunityMemberships(db, nowIso = new Date().toISOString()) {
  if (tableExists(db, 'community_permissions')) {
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
  // 单小区且没有任何历史授权时，所有在职档案默认属于该唯一小区；
  // 多小区或存在旧授权时不猜测归属，避免越权和串区。
  if (tableExists(db, 'communities')) {
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
  }
}

function ensureWorkforceSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS staff_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  db.run(`
    CREATE TABLE IF NOT EXISTS shift_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      UNIQUE (staff_id, work_date)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER,
      shift_assignment_id INTEGER,
      work_date TEXT,
      check_in_at TEXT,
      check_out_at TEXT,
      status TEXT DEFAULT 'not_started',
      is_corrected INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT '',
      UNIQUE (staff_id, work_date)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      import_key TEXT UNIQUE NOT NULL,
      imported_by INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      summary_json TEXT DEFAULT '{}'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS performance_rule_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_no INTEGER UNIQUE NOT NULL,
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
      community_id TEXT NOT NULL,
      staff_profile_id INTEGER NOT NULL,
      created_at TEXT DEFAULT '',
      created_by_user_id INTEGER,
      UNIQUE (community_id, staff_profile_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_report_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  addColumn(db, 'tickets', 'assignee_user_id INTEGER');
  addColumn(db, 'tickets', 'assignee_staff_profile_id INTEGER');
  addColumn(db, 'tickets', "assigned_at TEXT DEFAULT ''");
  addColumn(db, 'tickets', 'performance_rule_version_id INTEGER');

  const nowIso = new Date().toISOString();
  db.run(`
    INSERT OR IGNORE INTO performance_rule_versions (
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
    ) VALUES (1, '默认规则', 30, 50, 20, 90, 80, 60, 1, ?, ?, 1)
  `, [nowIso, nowIso]);

  if (tableExists(db, 'tickets')) {
    // Bind only through the authenticated user identity. In particular, never
    // infer a profile from worker/name text because names are not unique and
    // historical snapshots must remain unambiguous.
    db.run(`
      UPDATE tickets
      SET assignee_staff_profile_id = (
        SELECT sp.id
        FROM staff_profiles sp
        WHERE sp.user_id = tickets.assignee_user_id
      )
      WHERE assignee_staff_profile_id IS NULL
        AND assignee_user_id IS NOT NULL
    `);

    db.run(`
      UPDATE tickets
      SET performance_rule_version_id = (
        SELECT id FROM performance_rule_versions WHERE version_no = 1
      )
      WHERE performance_rule_version_id IS NULL
    `);
  }

  backfillCommunityMemberships(db, nowIso);

  db.run('CREATE INDEX IF NOT EXISTS idx_staff_manager ON staff_profiles(manager_id)');
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
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_report_cache
    ON ai_report_analyses(report_hash, model, prompt_version)`);
}

module.exports = { ensureWorkforceSchema, addColumn, backfillCommunityMemberships };
