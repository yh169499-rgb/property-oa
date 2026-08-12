/**
 * 人员状态路由
 */
const express = require('express');
const router = express.Router();
const { queryAll, run, saveDB } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isSupervisorUser } = require('../services/roles');

// POST /api/staff/status
router.post('/status', requireAuth, async (req, res) => {
  const { name, status } = req.body;
  if (!name || !status) return res.status(400).json({ error: '缺少 name 或 status' });
  if (!isSupervisorUser(req.user) && String(name).trim() !== String(req.user.name || '').trim()) {
    return res.status(403).json({ error: '只能更新自己的在岗状态', code: 'STATUS_SCOPE_FORBIDDEN' });
  }
  const allowed = ['on', 'busy', 'off'];
  if (!allowed.includes(status)) return res.status(400).json({ error: '无效状态值' });
  run('INSERT OR REPLACE INTO staff_status (name, status, updated) VALUES (?, ?, ?)', [name, status, new Date().toISOString()]);
  await saveDB();
  res.json({ success: true, name, status });
});

// GET /api/staff/status
router.get('/status', requireAuth, (req, res) => {
  const rows = isSupervisorUser(req.user)
    ? queryAll('SELECT * FROM staff_status')
    : queryAll('SELECT * FROM staff_status WHERE name = ?', [req.user.name]);
  res.json({ data: rows });
});

module.exports = router;
