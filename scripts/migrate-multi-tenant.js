const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { ensureDatabaseSchema } = require('../db');
const {
  DEFAULT_INPUT,
  inspectTenantMigration,
  applyTenantMigration,
} = require('../services/tenant-migration');

const CONFIRM_PHRASE = 'MIGRATE-MULTI-TENANT';
const WORKSPACE_DATABASE = path.resolve(__dirname, '..', 'data.db');

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--apply') values.apply = true;
    else if (argument === '--help') values.help = true;
    else if (argument.startsWith('--source=')) values.source = argument.slice('--source='.length);
    else if (argument.startsWith('--confirm=')) values.confirm = argument.slice('--confirm='.length);
    else if (argument.startsWith('--test-supervisor-phone=')) {
      values.testSupervisorPhone = argument.slice('--test-supervisor-phone='.length);
    } else if (argument.startsWith('--test-tenant-id=')) {
      values.testTenantId = argument.slice('--test-tenant-id='.length);
    } else if (argument.startsWith('--test-tenant-name=')) {
      values.testTenantName = argument.slice('--test-tenant-name='.length);
    } else if (argument.startsWith('--test-staff-limit=')) {
      values.testStaffLimit = Number(argument.slice('--test-staff-limit='.length));
    } else if (argument.startsWith('--now=')) values.nowIso = argument.slice('--now='.length);
    else throw new Error(`未知参数：${argument}`);
  }
  return values;
}

function validateOptions(options) {
  if (!options.source) throw new Error('必须通过 --source 指定数据库文件');
  if (!path.isAbsolute(options.source)) throw new Error('source 必须是绝对路径');
  if (options.apply && options.confirm !== CONFIRM_PHRASE) {
    throw new Error(`执行写入必须提供确认口令 ${CONFIRM_PHRASE}`);
  }
  if (options.apply && fs.existsSync(options.source)
    && fs.lstatSync(options.source).isSymbolicLink()) {
    throw new Error('apply 拒绝使用符号链接 source；请传入真实候选库绝对路径');
  }
  const resolvedSource = fs.existsSync(options.source)
    ? fs.realpathSync(options.source)
    : path.resolve(options.source);
  const resolvedWorkspace = fs.existsSync(WORKSPACE_DATABASE)
    ? fs.realpathSync(WORKSPACE_DATABASE)
    : WORKSPACE_DATABASE;
  if (options.apply && resolvedSource === resolvedWorkspace) {
    throw new Error('禁止直接修改工作区本地开发 data.db；请复制到独立候选路径');
  }
  if (!fs.existsSync(options.source)) throw new Error('source 数据库文件不存在');
  if (!fs.statSync(options.source).isFile()) throw new Error('source 必须是数据库文件');
}

function backupName(source, nowIso) {
  const stamp = new Date(nowIso || Date.now()).toISOString().replace(/[:.]/g, '-');
  let candidate = `${source}.before-multi-tenant-${stamp}.db`;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${source}.before-multi-tenant-${stamp}-${index}.db`;
    index += 1;
  }
  return candidate;
}

function atomicWrite(source, bytes) {
  const temporary = `${source}.tenant-migration.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, source);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

async function migrateMultiTenantFile(options = {}) {
  validateOptions(options);
  const original = fs.readFileSync(options.source);
  const SQL = await initSqlJs();
  const db = new SQL.Database(original);
  let report;
  let migrated;
  try {
    ensureDatabaseSchema(db);
    const input = {
      testSupervisorPhone: options.testSupervisorPhone ?? DEFAULT_INPUT.testSupervisorPhone,
      testTenantId: options.testTenantId ?? DEFAULT_INPUT.testTenantId,
      testTenantName: options.testTenantName ?? DEFAULT_INPUT.testTenantName,
      testStaffLimit: options.testStaffLimit ?? DEFAULT_INPUT.testStaffLimit,
      nowIso: options.nowIso || new Date().toISOString(),
    };
    if (!options.apply) {
      report = inspectTenantMigration(db, input);
      return {
        mode: 'dry-run',
        source: path.resolve(options.source),
        backupPath: null,
        report,
      };
    }
    const migration = applyTenantMigration(db, input);
    report = { ...migration.preview, integrity: migration.integrity };
    migrated = Buffer.from(db.export());
  } finally {
    db.close();
  }

  const backupPath = backupName(options.source, options.nowIso);
  fs.copyFileSync(options.source, backupPath, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backupPath, 0o400); } catch (_) {}
  try {
    atomicWrite(options.source, migrated);
  } catch (error) {
    try {
      fs.chmodSync(backupPath, 0o600);
      fs.copyFileSync(backupPath, options.source);
      fs.chmodSync(backupPath, 0o400);
    } catch (_) {}
    throw error;
  }
  return {
    mode: 'apply',
    source: path.resolve(options.source),
    backupPath,
    report,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('用法：node scripts/migrate-multi-tenant.js --source=/absolute/path/data.db [--apply --confirm=MIGRATE-MULTI-TENANT]');
    return;
  }
  const result = await migrateMultiTenantFile({ ...args, apply: Boolean(args.apply) });
  console.log(JSON.stringify(result, null, 2));
  if (!result.report.ok) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRM_PHRASE,
  parseArgs,
  validateOptions,
  atomicWrite,
  migrateMultiTenantFile,
};
