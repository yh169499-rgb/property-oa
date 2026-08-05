const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { getSupabaseStorageConfig, uploadDatabase } = require('../services/supabase-storage');
const { inspectSqliteFile } = require('../services/database-inspection');

function parseMigrationArgs(argv) {
  const sourceArg = argv.find(value => value.startsWith('--source='));
  const source = sourceArg ? sourceArg.slice('--source='.length) : '';
  const confirm = argv.includes('--confirm');
  if (!source) throw new Error('必须提供 --source=/absolute/path/to/data.db');
  if (!confirm) throw new Error('迁移会覆盖远程数据库，必须显式提供 --confirm');
  return { source: path.resolve(source), confirm };
}

async function migrateSqliteFile({ source, confirm, upload }) {
  if (!confirm) throw new Error('迁移会覆盖远程数据库，必须显式提供 --confirm');
  if (!fs.existsSync(source)) throw new Error(`源数据库不存在：${source}`);
  const bytes = fs.readFileSync(source);
  const backupPath = `${source}.bak`;
  fs.copyFileSync(source, backupPath);
  const summary = await inspectSqliteFile(source);
  const result = await upload(bytes);
  return { source, backupPath, ...summary, upload: result };
}

async function main() {
  const { source, confirm } = parseMigrationArgs(process.argv.slice(2));
  const storageConfig = getSupabaseStorageConfig(config);
  if (!storageConfig) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  const result = await migrateSqliteFile({
    source,
    confirm,
    upload: bytes => uploadDatabase(storageConfig, bytes),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseMigrationArgs, migrateSqliteFile };