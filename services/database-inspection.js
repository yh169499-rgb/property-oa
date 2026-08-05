const crypto = require('node:crypto');
const fs = require('node:fs');
const initSqlJs = require('sql.js');

async function inspectSqliteFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  const tableRows = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0]?.values || [];
  const tables = {};
  for (const [name] of tableRows) {
    const escaped = String(name).replace(/"/g, '""');
    const result = db.exec(`SELECT COUNT(*) AS count FROM "${escaped}"`);
    tables[name] = { count: Number(result[0]?.values?.[0]?.[0] || 0) };
  }
  return {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    tables,
  };
}

module.exports = { inspectSqliteFile };