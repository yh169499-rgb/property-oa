function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  const result = db.exec(`PRAGMA table_info(${table})`);
  const existing = result[0] ? result[0].values.map((row) => row[1]) : [];

  if (!existing.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
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
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      CHECK (manager_id IS NULL OR manager_id <> id)
    )
  `);

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

  addColumn(db, 'tickets', 'assignee_user_id INTEGER');
  addColumn(db, 'tickets', "assigned_at TEXT DEFAULT ''");

  db.run('CREATE INDEX IF NOT EXISTS idx_staff_manager ON staff_profiles(manager_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_shift_staff_date ON shift_assignments(staff_id, work_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_attendance_staff_date ON attendance_records(staff_id, work_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ticket_activity_actor_time ON ticket_activity_logs(actor_staff_id, created_at)');
}

module.exports = { ensureWorkforceSchema, addColumn };
