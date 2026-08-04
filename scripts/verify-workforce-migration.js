#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('../config');
const { ensureWorkforceSchema } = require('../workforce-schema');
const { migrateUsersToProfiles, backfillTicketAssignees, listUnmatchedAssignees } = require('../services/workforce-migration');

function scalar(db, sql) {
  const result = db.exec(sql);
  return result.length && result[0].values.length ? Number(result[0].values[0][0]) : 0;
}

async function main() {
  const source = path.resolve(config.DB_PATH);
  if (!fs.existsSync(source)) throw new Error(`数据库不存在：${source}`);
  const copy = `${source}.workforce-verify-${Date.now()}`;
  fs.copyFileSync(source, copy);
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(copy));
  const users = scalar(db, 'SELECT COUNT(*) FROM users');
  ensureWorkforceSchema(db);
  const profilesBefore = scalar(db, 'SELECT COUNT(*) FROM staff_profiles');
  const assignedBefore = scalar(db, 'SELECT COUNT(*) FROM tickets WHERE assignee_user_id IS NOT NULL');
  migrateUsersToProfiles(db, new Date().toISOString());
  backfillTicketAssignees(db);
  const profilesAfter = scalar(db, 'SELECT COUNT(*) FROM staff_profiles');
  const assignedAfter = scalar(db, 'SELECT COUNT(*) FROM tickets WHERE assignee_user_id IS NOT NULL');
  const unmatched = listUnmatchedAssignees(db);
  fs.writeFileSync(copy, Buffer.from(db.export()));
  db.close();
  console.log(`1. 源数据库：${source}`);
  console.log(`2. 验证副本：${copy}`);
  console.log(`3. 用户/档案：${users}/${profilesAfter}（新增 ${profilesAfter - profilesBefore}）`);
  console.log(`4. 工单关联：${assignedAfter}（新增 ${assignedAfter - assignedBefore}）`);
  console.log(`5. 未匹配人员：${unmatched.length}${unmatched.length ? ` ${JSON.stringify(unmatched)}` : ''}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
