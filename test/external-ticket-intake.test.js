const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFullTestDB,
  indexNames,
  tableNames,
} = require('./helpers/tenant-fixture');

test('external ticket intake audit schema exposes required fields and indexes', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  assert.ok(tableNames(db).includes('ticket_ingest_events'));

  const columns = db.exec('PRAGMA table_info(ticket_ingest_events)')[0].values;
  const columnsByName = new Map(columns.map((column) => [column[1], column]));
  for (const name of ['tenant_id', 'decision', 'repeat_key', 'request_json']) {
    assert.ok(columnsByName.has(name), `missing column: ${name}`);
  }
  assert.equal(columnsByName.get('ticket_id')[3], 0, 'ticket_id should allow NULL');

  const indexes = indexNames(db);
  assert.ok(indexes.includes('idx_ticket_ingest_tenant_created'));
  assert.ok(indexes.includes('idx_ticket_ingest_ticket'));
});
