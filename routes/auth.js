/**
 * 认证路由：登录 / 注册 / 重置密码
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const database = require('../db');
const { queryOne, queryAll, run, getDB } = database;
const { generateToken, requireAuth, requireAdmin, requireTenantUser } = require('../middleware/auth');
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
  try {
    const { phone, password, rememberMe } = req.body;
    if (!phone || !password) return res.status(400).json({ error: '请输入手机号和密码' });
    const user = queryOne(`SELECT u.*,t.status AS tenant_status FROM users u
      LEFT JOIN tenants t ON t.id=u.tenant_id WHERE u.phone=?`, [phone]);
    if (!user) return res.status(401).json({ error: '手机号未注册' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: '密码错误' });
    if (user.role === 'platform_owner') {
      return res.status(403).json({ error: '平台账号请使用平台登录入口', code: 'PLATFORM_LOGIN_REQUIRED' });
    }
    if (String(user.status || '') !== 'active' || !user.tenant_id || user.tenant_status !== 'active') {
      return res.status(403).json({ error: '账号或企业已停用' });
    }
    const nowIso = new Date().toISOString();
    run('UPDATE users SET last_login_at=? WHERE id=?', [nowIso, user.id]);
    try {
      await database.saveDB();
    } catch (error) {
      run('UPDATE users SET last_login_at=? WHERE id=?', [user.last_login_at ?? null, user.id]);
      throw error;
    }
    const token = generateToken(user, rememberMe);
    res.json({ success: true, token, user: {
      id: user.id, phone: user.phone, name: user.name, role: user.role, tenant_id: user.tenant_id,
    } });
  } catch (_) {
    res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
  }
});

// POST /api/reset-password
router.post('/reset-password', requireAuth, requireTenantUser, async (req, res) => {
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) return res.status(400).json({ error: '手机号和新密码必填' });
  if (newPassword.length < 4) return res.status(400).json({ error: '密码至少4位' });
  const user = queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user || user.role === 'platform_owner' || user.tenant_id !== req.user.tenant_id) {
    return res.status(404).json({ error: '用户不存在', code: 'USER_NOT_FOUND' });
  }
  const canReset = String(req.user.id) === String(user.id)
    || req.user.role === '主管';
  if (!canReset) return res.status(403).json({ error: '只能修改自己的密码，或由主管操作' });
  const hash = await bcrypt.hash(newPassword, 10);
  run('UPDATE users SET password = ?, session_version = session_version + 1 WHERE phone = ?', [hash, phone]);
  await database.saveDB();
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
  await database.saveDB();
  res.json({ success: true, message: '注册申请已提交，请等待主管审核' });
});

// GET /api/pending-registrations
router.get('/pending-registrations', requireAuth, requireAdmin, (req, res) => {
  const rows = queryAll(`SELECT id, phone, name, role, skill, community_id, status, created
    FROM pending_registrations WHERE status = 'pending' ORDER BY created DESC`);
  res.json({ data: rows, pending_count: rows.length });
});

// POST /api/pending-registrations/:id/approve
router.post('/pending-registrations/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const approved = approvePendingRegistration(getDB(), req.params.id, req.user);
    await database.saveDB();
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
  await database.saveDB();
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
    await database.saveDB();
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
    await database.saveDB();
    res.json({ success: true, departed: true, profileId: departed.profileId, message: '人员已离职，账号已删除，历史记录已保留' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '人员离职失败，请稍后重试', code: error.code });
  }
});

module.exports = router;
