const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { migrateRetainedTestData } = require('../services/retained-test-data');

const CONFIRM_PHRASE = 'RETAINED-TEST-DATA';
const WORKSPACE_DATABASE = path.resolve(__dirname, '..', 'data.db');

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--apply') values.apply = true;
    else if (argument.startsWith('--source=')) values.source = argument.slice('--source='.length);
    else if (argument.startsWith('--confirm=')) values.confirm = argument.slice('--confirm='.length);
    else if (argument.startsWith('--now=')) values.now = new Date(argument.slice('--now='.length));
    else if (argument === '--help') values.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return values;
}

function validateOptions(options) {
  if (!options.password) throw new Error('缺少 RETAINED_TEST_PASSWORD');
  if (!options.source) throw new Error('必须通过 --source 指定数据库文件');
  if (!path.isAbsolute(options.source)) throw new Error('source 必须是绝对路径');
  if (options.apply && options.confirm !== CONFIRM_PHRASE) {
    throw new Error(`执行写入必须提供确认口令 ${CONFIRM_PHRASE}`);
  }
  if (options.apply && path.resolve(options.source) === WORKSPACE_DATABASE) {
    throw new Error('禁止直接修改工作区本地开发 data.db；请先复制到独立候选路径');
  }
  if (!fs.existsSync(options.source)) throw new Error('source 数据库文件不存在');
  const stat = fs.statSync(options.source);
  if (!stat.isFile()) throw new Error('source 必须是数据库文件');
}

function backupName(source, now) {
  const stamp = new Date(now || Date.now()).toISOString().replace(/[:.]/g, '-');
  let candidate = `${source}.before-retained-${stamp}.db`;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${source}.before-retained-${stamp}-${index}.db`;
    index += 1;
  }
  return candidate;
}

function atomicWrite(source, bytes) {
  const temporary = `${source}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, source);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) { /* 保留原始错误 */ }
    throw error;
  }
}

async function prepareRetainedTestData(options = {}) {
  validateOptions(options);
  const original = fs.readFileSync(options.source);
  const SQL = await initSqlJs();
  const db = new SQL.Database(original);
  let migration;
  let migrated;
  try {
    migration = migrateRetainedTestData(db, options);
    migrated = Buffer.from(db.export());
  } finally {
    db.close();
  }
  const common = {
    source: path.resolve(options.source),
    retainedAccounts: Number(migration.summary.retainedAccounts),
    disabledAccounts: Number(migration.summary.disabledAccounts),
    mockTickets: Number(migration.summary.mockTickets),
    mockAssignments: Number(migration.summary.mockAssignments),
    mockActivities: Number(migration.summary.mockActivities),
  };
  if (!options.apply) return { mode: 'dry-run', backupPath: null, ...common };
  const backupPath = backupName(options.source, options.now);
  fs.copyFileSync(options.source, backupPath, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backupPath, 0o600); } catch (_) { /* 文件系统可能不支持 chmod */ }
  try {
    atomicWrite(options.source, migrated);
  } catch (error) {
    try { fs.copyFileSync(backupPath, options.source); } catch (_) { /* 保留备份供人工恢复 */ }
    throw error;
  }
  return { mode: 'apply', backupPath, ...common };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('用法：RETAINED_TEST_PASSWORD=<运行时输入> node scripts/prepare-retained-test-data.js --source=/absolute/path/data.db [--apply --confirm=RETAINED-TEST-DATA]');
    return;
  }
  const result = await prepareRetainedTestData({
    ...args,
    apply: Boolean(args.apply),
    password: process.env.RETAINED_TEST_PASSWORD || '',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRM_PHRASE,
  parseArgs,
  validateOptions,
  prepareRetainedTestData,
};
