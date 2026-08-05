/**
 * 认证路由：登录 / 注册 / 重置密码
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { queryOne, queryAll, run, saveDB } = require('../db');
const { generateToken, requireAuth, requireAdmin } = require('../middleware/auth');

// POST /api/login
router.post('/login', async (req, res) => {
  const { phone, password, rememberMe } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '请输入手机号和密码' });
  const user = queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) return res.status(401).json({ error: '手机号未注册' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: '密码错误' });
  const token = generateToken(user, rememberMe);
  res.json({ success: true, token, user: { id: user.id, phone: user.phone, name: user.name, role: user.role } });
});

// POST /api/reset-password
router.post('/reset-password', async (req, res) => {
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) return res.status(400).json({ error: '手机号和新密码必填' });
  if (newPassword.length < 4) return res.status(400).json({ error: '密码至少4位' });
  const user = queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) return res.status(404).json({ error: '该手机号未注册' });
  const hash = await bcrypt.hash(newPassword, 10);
  run('UPDATE users SET password = ? WHERE phone = ?', [hash, phone]);
  saveDB();
  res.json({ success: true, message: '密码已重置' });
});

// POST /api/register（邀请码注册）
router.post('/register', async (req, res) => {
  const { phone, password, name, role, skill, inviteCode } = req.body;
  if (!phone || !password || !name) return res.status(400).json({ error: '手机号、密码、姓名必填' });
  if (!inviteCode) return res.status(400).json({ error: '请输入邀请码' });
  const invite = queryOne('SELECT * FROM invite_codes WHERE code = ?', [inviteCode.toUpperCase()]);
  if (!invite) return res.status(400).json({ error: '邀请码无效' });
  const existUser = queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
  if (existUser) return res.status(400).json({ error: '该手机号已注册，请直接登录' });
  const existPending = queryOne("SELECT * FROM pending_registrations WHERE phone = ? AND status = 'pending'", [phone]);
  if (existPending) return res.status(400).json({ error: '该手机号已提交注册申请，请等待审核' });
  const hash = await bcrypt.hash(password, 10);
  run(
    'INSERT INTO pending_registrations (phone, password, name, role, skill, community_id, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [phone, hash, name, role || 'worker', skill || '', invite.community_id, 'pending', new Date().toISOString()]
  );
  saveDB();
  res.json({ success: true, message: '注册申请已提交，请等待主管审核' });
});

// GET /api/pending-registrations
router.get('/pending-registrations', requireAuth, requireAdmin, (req, res) => {
  const rows = queryAll("SELECT * FROM pending_registrations WHERE status = 'pending' ORDER BY created DESC");
  res.json({ data: rows });
});

// POST /api/pending-registrations/:id/approve
router.post('/pending-registrations/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const reg = queryOne('SELECT * FROM pending_registrations WHERE id = ?', [req.params.id]);
  if (!reg) return res.status(404).json({ error: '记录不存在' });
  if (reg.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });
  try {
    run('INSERT INTO users (phone, password, name, role) VALUES (?, ?, ?, ?)', [reg.phone, reg.password, reg.name, reg.role]);
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '该手机号已注册' });
    return res.status(500).json({ error: e.message });
  }
  run('INSERT OR IGNORE INTO community_permissions (community_id, staff_name) VALUES (?, ?)', [reg.community_id, reg.name]);
  run("UPDATE pending_registrations SET status = 'approved' WHERE id = ?", [req.params.id]);
  saveDB();
  res.json({ success: true, message: '已通过', user: { phone: reg.phone, name: reg.name, role: reg.role, community_id: reg.community_id } });
});

// POST /api/pending-registrations/:id/reject
router.post('/pending-registrations/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const reg = queryOne('SELECT * FROM pending_registrations WHERE id = ?', [req.params.id]);
  if (!reg) return res.status(404).json({ error: '记录不存在' });
  run("UPDATE pending_registrations SET status = 'rejected' WHERE id = ?", [req.params.id]);
  saveDB();
  res.json({ success: true, message: '已拒绝' });
});

// POST /api/users（主管创建）
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const { phone, password, name, role } = req.body;
  if (!phone || !password || !name) return res.status(400).json({ error: '手机号、密码、姓名必填' });
  try {
    const hash = await bcrypt.hash(password, 10);
    run('INSERT INTO users (phone, password, name, role) VALUES (?, ?, ?, ?)', [phone, hash, name, role || 'worker']);
    saveDB();
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '该手机号已注册' });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/users
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = queryAll('SELECT id, phone, name, role FROM users');
  res.json({ data: users });
});

// DELETE /api/users/:id
router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  run('DELETE FROM users WHERE id = ?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});

module.exports = router;
