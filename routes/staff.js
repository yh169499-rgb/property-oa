/**
 * 人员状态路由
 */
const express = require('express');
const router = express.Router();
const { queryAll, run, saveDB } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isSupervisorUser } = require('../services/roles');
const {
  tenantIdFrom,
  assertNoClientTenant,
} = require('../services/tenant-context');

function fail(res, error) {
  return res.status(error.status || 500).json({
    error: error.message,
    code: error.code || 'INTERNAL_ERROR',
  });
}

// POST /api/staff/status
router.post('/status', requireAuth, async (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    const { name, status } = req.body;
    if (!name || !status) return res.status(400).json({ error: '缺少 name 或 status' });
    if (!isSupervisorUser(req.user) && String(name).trim() !== String(req.user.name || '').trim()) {
      return res.status(403).json({ error: '只能更新自己的在岗状态', code: 'STATUS_SCOPE_FORBIDDEN' });
    }
    const allowed = ['on', 'busy', 'off'];
    if (!allowed.includes(status)) return res.status(400).json({ error: '无效状态值' });

    const localMatches = queryAll(
      `SELECT id FROM staff_profiles
       WHERE tenant_id = ? AND TRIM(name) = TRIM(?)
         AND COALESCE(employment_status, 'active') = 'active'`,
      [tenantId, name]
    );
    if (localMatches.length !== 1) {
      const foreign = queryAll(
        `SELECT id FROM staff_profiles
         WHERE tenant_id <> ? AND TRIM(name) = TRIM(?)
           AND COALESCE(employment_status, 'active') = 'active'`,
        [tenantId, name]
      );
      if (localMatches.length === 0 && foreign.length) {
        return res.status(403).json({
          error: '禁止修改其他企业的数据',
          code: 'CROSS_TENANT_WRITE_FORBIDDEN',
        });
      }
      return res.status(localMatches.length ? 409 : 404).json({
        error: localMatches.length ? '姓名对应多个在职人员' : '人员档案不存在',
        code: localMatches.length ? 'AMBIGUOUS_STAFF_NAME' : 'PROFILE_NOT_FOUND',
      });
    }
    const updatedAt = new Date().toISOString();
    run(
      `UPDATE staff_status SET status = ?, updated = ?
       WHERE tenant_id = ? AND name = ?`,
      [status, updatedAt, tenantId, name]
    );
    const existingStatus = queryAll(
      'SELECT 1 FROM staff_status WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );
    if (!existingStatus.length) {
      run(
        'INSERT INTO staff_status (tenant_id, name, status, updated) VALUES (?, ?, ?, ?)',
        [tenantId, name, status, updatedAt]
      );
    }
    await saveDB();
    res.json({ success: true, name, status });
  } catch (error) {
    fail(res, error);
  }
});

// GET /api/staff/status
router.get('/status', requireAuth, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    const rows = isSupervisorUser(req.user)
      ? queryAll('SELECT * FROM staff_status WHERE tenant_id = ?', [tenantId])
      : queryAll(
        'SELECT * FROM staff_status WHERE tenant_id = ? AND name = ?',
        [tenantId, req.user.name]
      );
    res.json({ data: rows });
  } catch (error) {
    fail(res, error);
  }
});

module.exports = router;
