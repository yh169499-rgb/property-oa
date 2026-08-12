const database = require('../db');

const REQUIRED_TABLES = [
  'users', 'staff_profiles', 'communities', 'tickets', 'shift_templates',
  'shift_assignments', 'attendance_records', 'performance_rule_versions',
];

async function main() {
  await database.initDB();
  const db = database.getDB();
  const missing = REQUIRED_TABLES.filter((table) => {
    const result = db.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    return !result[0] || !result[0].values.length;
  });
  if (missing.length) throw new Error(`缺少数据表: ${missing.join(', ')}`);
  const counts = {};
  REQUIRED_TABLES.forEach((table) => {
    counts[table] = db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0];
  });
  console.log(JSON.stringify({ ok: true, counts }));
  await database.flushPersistence();
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { REQUIRED_TABLES };
