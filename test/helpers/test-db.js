const initSqlJs = require('sql.js');

async function createTestDB() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'worker'
    )
  `);
  db.run(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      worker TEXT DEFAULT ''
    )
  `);

  return db;
}

function valuesFrom(db, sql) {
  const result = db.exec(sql);
  return result[0] ? result[0].values : [];
}

function tableNames(db) {
  return valuesFrom(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).map((row) => row[0]);
}

function columnNames(db, table) {
  return valuesFrom(db, `PRAGMA table_info(${table})`).map((row) => row[1]);
}

function indexNames(db) {
  return valuesFrom(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'index'"
  ).map((row) => row[0]);
}

module.exports = { createTestDB, tableNames, columnNames, indexNames };
