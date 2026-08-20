function columnNames(db, table) {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result[0] ? result[0].values.map((row) => row[1]) : [];
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!columnNames(db, table).includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function ensureCoreSchema(db) {
  db.run('SAVEPOINT ensure_core_schema');
  try {
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
        metadata TEXT DEFAULT '{}',
        performance_rule_version_id INTEGER
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS communities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT DEFAULT '',
        created TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS community_permissions (
        community_id TEXT NOT NULL,
        staff_name TEXT NOT NULL,
        PRIMARY KEY (community_id, staff_name)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        created TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS pending_registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'worker',
        skill TEXT DEFAULT '',
        community_id TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'worker',
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS staff_status (
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'on',
        updated TEXT
      )
    `);

    const migrations = [
      ['users', "status TEXT NOT NULL DEFAULT 'active'"],
      ['tickets', "session_id TEXT DEFAULT ''"],
      ['tickets', "community_id TEXT DEFAULT 'default'"],
      ['tickets', "repeat_key TEXT DEFAULT ''"],
      ['tickets', "repeat_of TEXT DEFAULT ''"],
      ['tickets', 'repeat_count INTEGER DEFAULT 1'],
      ['tickets', 'is_recurring INTEGER DEFAULT 0'],
      ['tickets', "recurrence_note TEXT DEFAULT ''"],
      ['tickets', 'feedback_count INTEGER DEFAULT 1'],
      ['tickets', "metadata TEXT DEFAULT '{}'"],
    ];
    for (const [table, definition] of migrations) addColumn(db, table, definition);

    db.run("UPDATE users SET role = '主管' WHERE LOWER(TRIM(role)) = 'lead'");
    db.run('CREATE INDEX IF NOT EXISTS idx_tickets_recurrence ON tickets (community_id, repeat_key, created)');
    db.run('RELEASE SAVEPOINT ensure_core_schema');
  } catch (error) {
    try {
      db.run('ROLLBACK TO SAVEPOINT ensure_core_schema');
      db.run('RELEASE SAVEPOINT ensure_core_schema');
    } catch (_) {}
    throw error;
  }
}

module.exports = { ensureCoreSchema };
