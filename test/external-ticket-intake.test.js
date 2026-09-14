const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFullTestDB,
  indexNames,
  one,
  rows,
  tableNames,
} = require('./helpers/tenant-fixture');
const {
  acceptExternalFeedback,
  normalizeLocation,
  resolveLocationCompleteness,
} = require('../services/external-ticket-intake');

const NOW = '2026-09-14T10:00:00.000Z';

function input(overrides = {}) {
  return {
    type: 'repair',
    cat: '水暖',
    desc: '居民反馈家中漏水，请安排检修。',
    loc: '3号楼502',
    message: '我家漏水了',
    feedback_person: 'A居民',
    feedback_group: '居民群',
    ...overrides,
  };
}

function accept(db, overrides = {}) {
  return acceptExternalFeedback({
    db,
    tenantId: overrides.tenantId || 'tenant-a',
    supervisor: overrides.supervisor || { id: 1, name: '主管甲' },
    community: overrides.community || { id: 'community-a', name: '阳光花园' },
    input: input(overrides.input),
    now: overrides.now || NOW,
  });
}

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

test('explicit location completeness is validated and placeholders are always incomplete', () => {
  assert.equal(resolveLocationCompleteness({ loc: '3号楼502', location_complete: false }), false);
  assert.equal(resolveLocationCompleteness({ loc: '3号楼502', locationComplete: true }), true);
  assert.equal(resolveLocationCompleteness({ loc: '3号楼502', location_complete: false, locationComplete: true }), true);
  for (const loc of ['', '未知', '待确认', '未提供', '暂不清楚']) {
    assert.equal(resolveLocationCompleteness({ loc }), false, loc || '(empty)');
    assert.equal(resolveLocationCompleteness({ loc, locationComplete: true }), false, `${loc || '(empty)'} explicit`);
  }
  assert.equal(resolveLocationCompleteness({ loc: '3号楼 502' }), true);
  assert.equal(resolveLocationCompleteness({ loc: '3号楼502', locationComplete: '1' }), true);
  assert.equal(resolveLocationCompleteness({ loc: '3号楼502', locationComplete: '0' }), false);
  assert.throws(
    () => resolveLocationCompleteness({ loc: '3号楼502', location_complete: 'maybe' }),
    (error) => error.status === 400 && error.code === 'INVALID_LOCATION_COMPLETE'
  );
});

test('location normalization folds full-width characters but keeps distinct rooms distinct', () => {
  assert.equal(normalizeLocation('３号楼 ５０２'), normalizeLocation('3号楼502'));
  assert.notEqual(normalizeLocation('3号楼502'), normalizeLocation('3号楼503'));
});

test('incomplete feedback is deferred without creating a ticket or source audit', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  const result = accept(db, { input: { loc: '待确认', locationComplete: true } });

  assert.deepEqual(result, { decision: 'deferred', ticketId: null, shouldAlert: false });
  assert.equal(one(db, 'SELECT COUNT(*) total FROM tickets').total, 0);
  assert.equal(one(db, 'SELECT COUNT(*) total FROM ticket_source_audits').total, 0);
  const event = one(db, 'SELECT * FROM ticket_ingest_events');
  assert.equal(event.tenant_id, 'tenant-a');
  assert.equal(event.community_id, 'community-a');
  assert.equal(event.ticket_id, null);
  assert.equal(event.decision, 'deferred');
});

test('same open issue merges atomically while freezing the first primary source', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  const first = accept(db);
  const second = accept(db, {
    now: '2026-09-14T10:10:00.000Z',
    input: {
      loc: '３号楼 ５０２',
      feedback_person: 'B居民',
      feedback_group: '另一个居民群',
      message: 'B说同一处也漏水',
    },
  });

  assert.equal(first.decision, 'created');
  assert.equal(first.shouldAlert, true);
  assert.deepEqual(second, { decision: 'merged', ticketId: first.ticketId, shouldAlert: false });
  assert.equal(one(db, 'SELECT COUNT(*) total FROM tickets').total, 1);
  const ticket = one(db, 'SELECT * FROM tickets WHERE id = ?', [first.ticketId]);
  assert.equal(ticket.feedback_count, 2);
  const metadata = JSON.parse(ticket.metadata);
  assert.equal(metadata.feedbackPerson, 'A居民');
  assert.equal(metadata.feedbackGroup, '居民群');
  assert.equal(metadata.originalMessage, '我家漏水了');
  assert.equal(rows(db, 'SELECT source FROM ticket_source_audits ORDER BY id').length, 2);
  assert.deepEqual(rows(db, 'SELECT source FROM ticket_source_audits ORDER BY id').map(row => row.source), ['external', 'external_merge']);
  assert.deepEqual(rows(db, 'SELECT decision FROM ticket_ingest_events ORDER BY id').map(row => row.decision), ['created', 'merged']);
});

test('three incomplete reports stay deferred and the first complete reporter creates the ticket', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  for (const feedbackPerson of ['A居民', 'B居民', 'C居民']) {
    assert.equal(accept(db, { input: { loc: '待确认', feedback_person: feedbackPerson } }).decision, 'deferred');
  }
  const complete = accept(db, { input: { feedback_person: 'D居民', message: 'D确认是502' } });

  assert.equal(complete.decision, 'created');
  const ticket = one(db, 'SELECT * FROM tickets WHERE id = ?', [complete.ticketId]);
  const metadata = JSON.parse(ticket.metadata);
  assert.equal(metadata.feedbackPerson, 'D居民');
  assert.equal(metadata.originalMessage, 'D确认是502');
  assert.equal(one(db, 'SELECT COUNT(*) total FROM tickets').total, 1);
  assert.equal(one(db, "SELECT COUNT(*) total FROM ticket_ingest_events WHERE decision='deferred'").total, 3);
});

test('different locations, tenants, and communities never merge', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  const first = accept(db);
  const differentRoom = accept(db, { input: { loc: '3号楼503' } });
  const differentTenant = accept(db, { tenantId: 'tenant-b' });
  const differentCommunity = accept(db, { community: { id: 'community-b', name: '月亮花园' } });

  assert.deepEqual([first, differentRoom, differentTenant, differentCommunity].map(item => item.decision),
    ['created', 'created', 'created', 'created']);
  assert.equal(one(db, 'SELECT COUNT(*) total FROM tickets').total, 4);
  assert.equal(new Set([first.ticketId, differentRoom.ticketId, differentTenant.ticketId, differentCommunity.ticketId]).size, 4);
});

test('a completed matching ticket within 30 days creates a recurring ticket', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  const first = accept(db, { now: '2026-09-01T10:00:00.000Z' });
  db.run("UPDATE tickets SET status='done', finished=? WHERE id=?", ['2026-09-01T12:00:00.000Z', first.ticketId]);
  const recurrence = accept(db, { now: NOW, input: { feedback_person: 'B居民', message: '又漏水了' } });

  assert.equal(recurrence.decision, 'created');
  assert.notEqual(recurrence.ticketId, first.ticketId);
  const ticket = one(db, 'SELECT * FROM tickets WHERE id = ?', [recurrence.ticketId]);
  assert.equal(ticket.repeat_of, first.ticketId);
  assert.equal(ticket.repeat_count, 2);
  assert.equal(ticket.is_recurring, 1);
  assert.match(ticket.recurrence_note, new RegExp(first.ticketId));
});

test('message is the canonical original and feedback person is never inferred', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());

  const created = accept(db, {
    input: {
      feedback_person: undefined,
      sender_name: '不得采用的名字',
      message: '标准原文',
      original_message: '旧字段原文',
    },
  });

  const ticket = one(db, 'SELECT * FROM tickets WHERE id = ?', [created.ticketId]);
  const metadata = JSON.parse(ticket.metadata);
  assert.equal(metadata.feedbackPerson, '');
  assert.equal(metadata.originalMessage, '标准原文');
  const source = one(db, 'SELECT * FROM ticket_source_audits WHERE ticket_id = ?', [created.ticketId]);
  assert.equal(source.feedback_person, '');
  assert.equal(source.original_message, '标准原文');
});

test('source insertion failure rolls back ticket and ingest event together', async (t) => {
  const db = await createFullTestDB();
  t.after(() => db.close());
  db.run(`CREATE TRIGGER fail_external_source BEFORE INSERT ON ticket_source_audits
    WHEN NEW.source = 'external' BEGIN SELECT RAISE(ABORT, 'source rejected'); END`);

  assert.throws(() => accept(db), /source rejected/);
  assert.equal(one(db, 'SELECT COUNT(*) total FROM tickets').total, 0);
  assert.equal(one(db, 'SELECT COUNT(*) total FROM ticket_source_audits').total, 0);
  assert.equal(one(db, 'SELECT COUNT(*) total FROM ticket_ingest_events').total, 0);
});
