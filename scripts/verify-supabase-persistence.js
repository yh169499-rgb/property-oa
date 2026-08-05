const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config');
const { getSupabaseStorageConfig, downloadDatabase } = require('../services/supabase-storage');
const { inspectSqliteFile } = require('../services/database-inspection');

async function verifyPersistence({ source, download }) {
  const local = await inspectSqliteFile(source);
  const remoteBytes = await download();
  if (!remoteBytes) throw new Error('remote database snapshot is missing');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-supabase-'));
  const remotePath = path.join(directory, 'remote.data.db');
  fs.writeFileSync(remotePath, remoteBytes);
  const remote = await inspectSqliteFile(remotePath);
  const tableNames = new Set([...Object.keys(local.tables), ...Object.keys(remote.tables)]);
  const differences = [...tableNames].filter(name => local.tables[name]?.count !== remote.tables[name]?.count);
  return {
    match: differences.length === 0 && local.sha256 === remote.sha256,
    differences,
    local,
    remote,
  };
}

async function main() {
  const source = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
  const storageConfig = getSupabaseStorageConfig(config);
  if (!storageConfig) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  const result = await verifyPersistence({
    source,
    download: () => downloadDatabase(storageConfig),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.match) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { verifyPersistence };