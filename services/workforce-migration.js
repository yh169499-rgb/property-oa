const crypto = require('crypto');

const IMPORT_FIELD_ALIASES = Object.freeze({
  birthMonth: 'birth_month',
  birth_month: 'birth_month',
  joinDate: 'join_date',
  join_date: 'join_date',
  phone: 'phone',
  position: 'position',
  skill: 'skill',
  employmentStatus: 'employment_status',
  employment_status: 'employment_status',
});

function normalizedImportPayload(value) {
  if (Array.isArray(value)) return value.map(normalizedImportPayload);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = normalizedImportPayload(value[key]);
      return result;
    }, {});
  }
  return typeof value === 'string' ? value.trim() : value;
}

function importKey(payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizedImportPayload(payload)))
    .digest('hex');
}

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function previewProfileImport(db, profiles) {
  const existing = rows(db, 'SELECT * FROM staff_profiles ORDER BY id');
  const byPhone = new Map(existing.filter((item) => item.phone).map((item) => [String(item.phone).trim(), item]));
  const byName = new Map();
  existing.forEach((item) => {
    const name = String(item.name || '').trim();
    if (!name) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(item);
  });
  const matches = [];
  const conflicts = [];
  const unmatched = [];
  (profiles || []).forEach((raw, index) => {
    const profile = normalizedImportPayload(raw || {});
    const phone = String(profile.phone || '').trim();
    const name = String(profile.name || '').trim();
    if (phone && byPhone.has(phone)) {
      matches.push({ index, matched_by: 'phone', profile: byPhone.get(phone), source: profile });
      return;
    }
    const named = name ? (byName.get(name) || []) : [];
    if (named.length === 1) {
      matches.push({ index, matched_by: 'name', profile: named[0], source: profile });
    } else if (named.length > 1) {
      conflicts.push({ index, reason: 'duplicate_name', candidates: named, source: profile });
    } else {
      unmatched.push({ index, reason: 'not_found', source: profile });
    }
  });
  return { matches, conflicts, unmatched };
}

function migrateUsersToProfiles(db, nowIso) {
  db.run(
    `
      INSERT OR IGNORE INTO staff_profiles (
        user_id,
        name,
        phone,
        position,
        employment_status,
        created_at,
        updated_at
      )
      SELECT
        id,
        name,
        phone,
        CASE
          WHEN role IN ('admin', 'lead', 'manager', 'supervisor', '主管', '经理') THEN '主管'
          WHEN role = 'worker' THEN '维修师傅'
          WHEN role = 'keeper' THEN '物业管家'
          ELSE '员工'
        END,
        'active',
        ?,
        ?
      FROM users
    `,
    [nowIso, nowIso]
  );
}

function backfillTicketAssignees(db) {
  db.run(`
    UPDATE tickets
    SET assignee_user_id = (
      SELECT sp.user_id
      FROM staff_profiles sp
      WHERE sp.name = tickets.worker
    )
    WHERE worker <> ''
      AND assignee_user_id IS NULL
      AND 1 = (
        SELECT COUNT(*)
        FROM staff_profiles sp
        WHERE sp.name = tickets.worker
      )
  `);
}

function listUnmatchedAssignees(db) {
  const statement = db.prepare(`
    SELECT worker, COUNT(*) AS ticket_count
    FROM tickets
    WHERE worker <> ''
      AND assignee_user_id IS NULL
    GROUP BY worker
    ORDER BY worker
  `);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

module.exports = {
  IMPORT_FIELD_ALIASES,
  normalizedImportPayload,
  importKey,
  previewProfileImport,
  migrateUsersToProfiles,
  backfillTicketAssignees,
  listUnmatchedAssignees,
};
