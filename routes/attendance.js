const express = require('express');
const database = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.delete('/attendance/:id', requireAuth, requireAdmin, (req, res) => {
  const statement = database.getDB().prepare('SELECT id FROM attendance_records WHERE id = ?');
  statement.bind([req.params.id]);
  const exists = statement.step();
  statement.free();
  if (!exists) return res.status(404).json({ error: '考勤记录不存在', code: 'ATTENDANCE_NOT_FOUND' });
  database.run('DELETE FROM attendance_records WHERE id = ?', [req.params.id]);
  database.saveDB();
  return res.json({ success: true });
});

module.exports = router;
