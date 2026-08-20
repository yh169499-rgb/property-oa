const initSqlJs = require('sql.js');

const { ensureCoreSchema } = require('../../services/core-schema');
const { ensureWorkforceSchema } = require('../../workforce-schema');
const { ensureTenantSchema } = require('../../services/tenant-schema');

async function createFullTestDB() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  ensureCoreSchema(db);
  ensureWorkforceSchema(db);
  ensureTenantSchema(db);
  return db;
}

function rows(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result[0]) return [];
  const { columns, values } = result[0];
  return values.map((valuesRow) => Object.fromEntries(
    columns.map((column, index) => [column, valuesRow[index]])
  ));
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function tableNames(db) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => row.name);
}

function columnNames(db, table) {
  return rows(db, `PRAGMA table_info(${table})`).map((row) => row.name);
}

function indexNames(db) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'index'")
    .map((row) => row.name);
}

module.exports = {
  createFullTestDB,
  rows,
  one,
  tableNames,
  columnNames,
  indexNames,
};
