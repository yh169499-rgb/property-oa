const express = require('express');
const database = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function count(sql) {
  const statement = database.getDB().prepare(sql);
  const value = statement.step() ? statement.getAsObject().count : 0;
  statement.free();
  return Number(value) || 0;
}

router.get('/attendance/summary', requireAuth, requireAdmin, (req, res) => {
  res.json({
    attendanceRecords: count('SELECT COUNT(*) AS count FROM attendance_records'),
    changeLogs: count('SELECT COUNT(*) AS count FROM attendance_change_logs'),
  });
});

router.post('/attendance/clear-all', requireAuth, requireAdmin, async (req, res) => {
  const attendanceRecords = count('SELECT COUNT(*) AS count FROM attendance_records');
  const changeLogs = count('SELECT COUNT(*) AS count FROM attendance_change_logs');
  database.run('DELETE FROM attendance_change_logs');
  database.run('DELETE FROM attendance_records');
  await database.saveDB();
  return res.json({
    success: true,
    deleted: { attendanceRecords, changeLogs },
    remaining: {
      attendanceRecords: count('SELECT COUNT(*) AS count FROM attendance_records'),
      changeLogs: count('SELECT COUNT(*) AS count FROM attendance_change_logs'),
    },
  });
});

router.delete('/attendance/:id', requireAuth, requireAdmin, async (req, res) => {
  const statement = database.getDB().prepare('SELECT id FROM attendance_records WHERE id = ?');
  statement.bind([req.params.id]);
  const exists = statement.step();
  statement.free();
  if (!exists) return res.status(404).json({ error: '考勤记录不存在', code: 'ATTENDANCE_NOT_FOUND' });
  database.run('DELETE FROM attendance_records WHERE id = ?', [req.params.id]);
  await database.saveDB();
  return res.json({ success: true });
});

module.exports = router;
