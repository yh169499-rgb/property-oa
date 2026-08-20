const { queryAll, queryOne, run, getDB } = require('../db');

function tableExists(name) {
  return Boolean(queryOne("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

function columnExists(table, column) {
  return tableExists(table) && queryAll(`PRAGMA table_info(${table})`).some(row => row.name === column);
}

function disableAccount(userId) {
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return { found: false };
  if (String(user.status || 'active') !== 'active') return { found: true, alreadyDisabled: true, user };

  const profile = tableExists('staff_profiles')
    ? queryOne('SELECT id, name FROM staff_profiles WHERE user_id = ?', [userId])
    : null;
  const hasSessionVersion = columnExists('users', 'session_version');
  const db = getDB();
  db.run('BEGIN TRANSACTION');
  try {
    run(`UPDATE users SET status = ?${hasSessionVersion ? ', session_version = session_version + 1' : ''}
      WHERE id = ?`, ['disabled', userId]);

    if (profile) {
      if (columnExists('staff_profiles', 'updated_at')) {
        run("UPDATE staff_profiles SET employment_status = 'inactive', updated_at = ? WHERE id = ?", [new Date().toISOString(), profile.id]);
      } else {
        run("UPDATE staff_profiles SET employment_status = 'inactive' WHERE id = ?", [profile.id]);
      }
      if (tableExists('community_memberships')) run('DELETE FROM community_memberships WHERE staff_profile_id = ?', [profile.id]);
      if (tableExists('shift_assignments')) run('DELETE FROM shift_assignments WHERE staff_id = ?', [profile.id]);
      if (tableExists('attendance_records')) run('DELETE FROM attendance_records WHERE staff_id = ?', [profile.id]);
      if (tableExists('attendance_change_logs') && tableExists('attendance_records')) {
        run('DELETE FROM attendance_change_logs WHERE attendance_id NOT IN (SELECT id FROM attendance_records)');
      }
      if (tableExists('staff_status')) run('DELETE FROM staff_status WHERE name = ?', [profile.name]);
    }
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw error;
  }
  return { found: true, user, profile };
}

function activeGlobalManagerCount(excludingUserId = null) {
  const hasStatus = columnExists('users', 'status');
  const rows = queryAll(
    `SELECT role${hasStatus ? ', status' : ''} FROM users${hasStatus ? " WHERE COALESCE(status, 'active') = 'active'" : ''}${excludingUserId == null ? '' : `${hasStatus ? ' AND' : ' WHERE'} id <> ?`}`,
    excludingUserId == null ? [] : [excludingUserId]
  );
  return rows.filter(row => ['admin', 'manager', 'supervisor', '主管', '经理'].includes(String(row.role || '').trim().toLowerCase())).length;
}

module.exports = { disableAccount, activeGlobalManagerCount };
