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
          WHEN role IN ('admin', 'lead') THEN '主管'
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
  migrateUsersToProfiles,
  backfillTicketAssignees,
  listUnmatchedAssignees,
};
