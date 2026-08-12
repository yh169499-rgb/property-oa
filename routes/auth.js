/**
 * 认证路由：登录 / 注册 / 重置密码
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { queryOne, queryAll, run, saveDB, getDB } = require('../db');
const { generateToken, requireAuth, requireAdmin } = require('../middleware/auth');
const {
  createStaffAccount,
  approvePendingRegistration,
  departStaff,
} = require('../services/staff-lifecycle');

function usersHaveStatusColumn() {
  return queryAll('PRAGMA table_info(users)').some(column => column.name === 'status');
}

// POST /api/login
router.post('/login', async (req, res) => {
  const { phone, password, rememberMe } = req.body;
  if (!phone || !password) return res.status(400).json({ error: '请输入手机号和密码' });
  const user = queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) return res.status(401).json({ error: '手机号未注册' });
  if (String(user.status || 'active') !== 'active') return res.status(403).json({ error: '账号已停用，请联系主管' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: '密码错误' });
  const token = generateToken(user, rememberMe);
  res.json({ success: true, token, user: { id: user.id, phone: user.phone, name: user.name, role: user.role } });
});

// POST /api/reset-password
router.post('/reset-password', requireAuth, async (req, res) => {
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) return res.status(400).json({ error: '手机号和新密码必填' });
  if (newPassword.length < 4) return res.status(400).json({ error: '密码至少4位' });
  const user = queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) return res.status(404).json({ error: '该手机号未注册' });
  const canReset = String(req.user.id) === String(user.id)
    || ['admin', 'manager', 'supervisor', '主管', '经理'].includes(String(req.user.role || '').trim().toLowerCase());
  if (!canReset) return res.status(403).json({ error: '只能修改自己的密码，或由主管操作' });
  const hash = await bcrypt.hash(newPassword, 10);
  run('UPDATE users SET password = ? WHERE phone = ?', [hash, phone]);
  await saveDB();
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
    [phone, hash, name, ['keeper'].includes(String(role || '').toLowerCase()) ? 'keeper' : 'worker', skill || '', invite.community_id, 'pending', new Date().toISOString()]
  );
  await saveDB();
  res.json({ success: true, message: '注册申请已提交，请等待主管审核' });
});

// GET /api/pending-registrations
router.get('/pending-registrations', requireAuth, requireAdmin, (req, res) => {
  const rows = queryAll("SELECT * FROM pending_registrations WHERE status = 'pending' ORDER BY created DESC");
  res.json({ data: rows });
});

// POST /api/pending-registrations/:id/approve
router.post('/pending-registrations/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const approved = approvePendingRegistration(getDB(), req.params.id, req.user);
    await saveDB();
    res.json({ success: true, message: '已通过', user: approved });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      return res.status(400).json({ error: '该手机号已注册', code: 'PHONE_ALREADY_REGISTERED' });
    }
    res.status(error.status || 500).json({ error: error.message, code: error.code });
  }
});

// POST /api/pending-registrations/:id/reject
router.post('/pending-registrations/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  const reg = queryOne('SELECT * FROM pending_registrations WHERE id = ?', [req.params.id]);
  if (!reg) return res.status(404).json({ error: '记录不存在' });
  run("UPDATE pending_registrations SET status = 'rejected' WHERE id = ?", [req.params.id]);
  await saveDB();
  res.json({ success: true, message: '已拒绝' });
});

// POST /api/users（主管创建）
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const { phone, password, name, role, skill, community_id, communityId } = req.body;
  if (!phone || !password || !name) return res.status(400).json({ error: '手机号、密码、姓名必填' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const created = createStaffAccount(getDB(), {
      phone,
      passwordHash: hash,
      name,
      role,
      skill,
      communityId: community_id || communityId || 'default',
    }, req.user);
    await saveDB();
    res.json({ success: true, user: created });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '该手机号已注册', code: 'PHONE_ALREADY_REGISTERED' });
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

// GET /api/users
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = usersHaveStatusColumn()
    ? queryAll(`SELECT u.id, u.phone, u.name, u.role, COALESCE(u.status, 'active') AS status
        FROM users u
        LEFT JOIN staff_profiles sp ON sp.user_id = u.id
        WHERE COALESCE(u.status, 'active') = 'active'
          AND (sp.id IS NULL OR COALESCE(sp.employment_status, 'active') = 'active')
        ORDER BY u.id`)
    : queryAll('SELECT id, phone, name, role FROM users ORDER BY id').map(user => ({ ...user, status: 'active' }));
  res.json({ data: users });
});

// DELETE /api/users/:id
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: '用户 ID 无效' });
  if (userId === Number(req.user.id)) return res.status(400).json({ error: '不能删除当前登录的主管账号' });
  const target = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  try {
    const departed = departStaff(getDB(), userId, req.user);
    await saveDB();
    res.json({ success: true, departed: true, profileId: departed.profileId, message: '人员已离职，账号已删除，历史记录已保留' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '人员离职失败，请稍后重试', code: error.code });
  }
});

module.exports = router;
