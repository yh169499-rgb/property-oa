/**
 * 小区管理路由
 */
const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run, saveDB, getDB } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { isSupervisorUser } = require('../services/roles');
const {
  httpError,
  tenantIdFrom,
  assertNoClientTenant,
  findTenantRow,
  assertTenantWriteTarget,
} = require('../services/tenant-context');

function fail(res, error) {
  return res.status(error.status || 500).json({
    error: error.message,
    code: error.code || 'INTERNAL_ERROR',
    details: error.details || {},
  });
}

function syncMemberships(tenantId, communityId, allowedStaff, actorUserId) {
  run('DELETE FROM community_memberships WHERE tenant_id = ? AND community_id = ?', [tenantId, communityId]);
  if (!Array.isArray(allowedStaff)) return;
  for (const name of allowedStaff) {
    const matches = queryAll(
      `SELECT id FROM staff_profiles
        WHERE tenant_id = ? AND TRIM(name) = TRIM(?)
          AND COALESCE(employment_status, 'active') = 'active'`,
      [tenantId, String(name || '')]
    );
    if (matches.length === 1) {
      run(
        `INSERT OR IGNORE INTO community_memberships
          (tenant_id, community_id, staff_profile_id, created_at, created_by_user_id)
          VALUES (?, ?, ?, ?, ?)`,
        [tenantId, communityId, matches[0].id, new Date().toISOString(), actorUserId]
      );
    }
  }
}

function validateAllowedStaff(tenantId, allowedStaff) {
  if (!Array.isArray(allowedStaff)) return;
  for (const name of allowedStaff) {
    const normalized = String(name || '').trim();
    const local = queryAll(
      `SELECT id FROM staff_profiles
       WHERE tenant_id = ? AND TRIM(name) = TRIM(?)
         AND COALESCE(employment_status, 'active') = 'active'`,
      [tenantId, normalized]
    );
    if (local.length === 1) continue;
    if (local.length > 1) {
      throw httpError(409, 'AMBIGUOUS_STAFF_NAME', '姓名对应多个在职人员');
    }
    const foreign = queryAll(
      `SELECT id FROM staff_profiles
       WHERE tenant_id <> ? AND TRIM(name) = TRIM(?)
         AND COALESCE(employment_status, 'active') = 'active'`,
      [tenantId, normalized]
    );
    if (foreign.length) {
      throw httpError(
        403,
        'CROSS_TENANT_WRITE_FORBIDDEN',
        '禁止引用其他企业的人员'
      );
    }
    throw httpError(404, 'PROFILE_NOT_FOUND', '授权人员档案不存在');
  }
}

function syncPermissions(tenantId, communityId, allowedStaff, actorUserId) {
  run('DELETE FROM community_permissions WHERE tenant_id = ? AND community_id = ?', [tenantId, communityId]);
  if (!Array.isArray(allowedStaff)) return;
  for (const staffName of allowedStaff) {
    run(
      `INSERT OR IGNORE INTO community_permissions (tenant_id, community_id, staff_name)
       VALUES (?, ?, ?)`,
      [tenantId, communityId, staffName]
    );
  }
  syncMemberships(tenantId, communityId, allowedStaff, actorUserId);
}

// GET /api/communities (登录后按当前企业与小区成员范围返回)
router.get('/', requireAuth, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    const staffName = req.query.staff_name;
    const supervisor = isSupervisorUser(req.user);
    let communities;
    if (supervisor && staffName) {
      communities = queryAll(
        `SELECT DISTINCT c.* FROM communities c
         LEFT JOIN community_permissions cp
           ON c.id = cp.community_id AND c.tenant_id = cp.tenant_id
         WHERE c.tenant_id = ? AND cp.staff_name = ?
         ORDER BY c.created ASC`, [tenantId, staffName]
      );
    } else if (supervisor) {
      communities = queryAll(
        'SELECT * FROM communities WHERE tenant_id = ? ORDER BY created ASC',
        [tenantId]
      );
    } else {
      communities = queryAll(
        `SELECT DISTINCT c.* FROM communities c
         LEFT JOIN community_permissions cp
           ON c.id = cp.community_id AND c.tenant_id = cp.tenant_id
         LEFT JOIN community_memberships cm
           ON c.id = cm.community_id AND c.tenant_id = cm.tenant_id
         LEFT JOIN staff_profiles sp
           ON sp.id = cm.staff_profile_id AND sp.tenant_id = cm.tenant_id
         WHERE c.tenant_id = ? AND (cp.staff_name = ? OR sp.user_id = ?)
         ORDER BY c.created ASC`, [tenantId, req.user.name, req.user.id]
      );
    }
    communities.forEach((community) => {
      community.allowedStaff = supervisor
        ? queryAll(
          `SELECT staff_name FROM community_permissions
           WHERE tenant_id = ? AND community_id = ?`,
          [tenantId, community.id]
        ).map(row => row.staff_name)
        : [];
    });
    res.json({ data: communities });
  } catch (error) {
    fail(res, error);
  }
});

// POST /api/communities (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    const { name, address, allowedStaff } = req.body;
    if (!name) return res.status(400).json({ error: '小区名称必填' });
    validateAllowedStaff(tenantId, allowedStaff);
    const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    run(
      'INSERT INTO communities (id, tenant_id, name, address, created) VALUES (?, ?, ?, ?, ?)',
      [id, tenantId, name, address || '', now]
    );
    if (Array.isArray(allowedStaff)) {
      syncPermissions(tenantId, id, allowedStaff, req.user.id);
    }
    await saveDB();
    res.json({
      success: true,
      community: { id, tenant_id: tenantId, name, address: address || '', created: now, allowedStaff: allowedStaff || [] },
    });
  } catch (error) {
    fail(res, error);
  }
});

// PATCH /api/communities/:id (admin only)
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    assertTenantWriteTarget(getDB(), {
      table: 'communities', id: req.params.id, tenantId,
      notFoundCode: 'COMMUNITY_NOT_FOUND', notFoundMessage: '小区不存在',
    });
    const { name, address, allowedStaff } = req.body;
    validateAllowedStaff(tenantId, allowedStaff);
    const sets = [];
    const values = [];
    if (name !== undefined) { sets.push('name = ?'); values.push(name); }
    if (address !== undefined) { sets.push('address = ?'); values.push(address); }
    if (sets.length) {
      run(
        `UPDATE communities SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...values, req.params.id, tenantId]
      );
    }
    if (allowedStaff !== undefined && Array.isArray(allowedStaff)) {
      syncPermissions(tenantId, req.params.id, allowedStaff, req.user.id);
    }
    await saveDB();
    const row = queryOne(
      'SELECT * FROM communities WHERE id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );
    row.allowedStaff = queryAll(
      `SELECT staff_name FROM community_permissions
       WHERE tenant_id = ? AND community_id = ?`,
      [tenantId, req.params.id]
    ).map(result => result.staff_name);
    res.json({ success: true, community: row });
  } catch (error) {
    fail(res, error);
  }
});

// DELETE /api/communities/:id (admin only)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    assertTenantWriteTarget(getDB(), {
      table: 'communities', id: req.params.id, tenantId,
      notFoundCode: 'COMMUNITY_NOT_FOUND', notFoundMessage: '小区不存在',
    });
    if (req.params.id === 'default') return res.status(400).json({ error: '默认小区不能删除' });
    const referenced = queryOne(
      'SELECT 1 FROM tickets WHERE tenant_id = ? AND community_id = ? LIMIT 1',
      [tenantId, req.params.id]
    );
    if (referenced) {
      return res.status(409).json({ error: '小区已存在工单，不能删除', code: 'COMMUNITY_IN_USE' });
    }
    run('DELETE FROM community_permissions WHERE tenant_id = ? AND community_id = ?', [tenantId, req.params.id]);
    run('DELETE FROM community_memberships WHERE tenant_id = ? AND community_id = ?', [tenantId, req.params.id]);
    run('DELETE FROM invite_codes WHERE tenant_id = ? AND community_id = ?', [tenantId, req.params.id]);
    run('DELETE FROM communities WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
    await saveDB();
    res.json({ success: true });
  } catch (error) {
    fail(res, error);
  }
});

// POST /api/communities/:id/invite-code (admin only)
router.post('/:id/invite-code', requireAuth, requireAdmin, async (req, res) => {
  try {
    assertNoClientTenant(req.body);
    const tenantId = tenantIdFrom(req);
    assertTenantWriteTarget(getDB(), {
      table: 'communities', id: req.params.id, tenantId,
      notFoundCode: 'COMMUNITY_NOT_FOUND', notFoundMessage: '小区不存在',
    });
    const existing = queryOne(
      'SELECT * FROM invite_codes WHERE tenant_id = ? AND community_id = ?',
      [tenantId, req.params.id]
    );
    if (existing) {
      return res.json({ success: true, code: existing.code, community_id: req.params.id });
    }
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    run(
      'INSERT INTO invite_codes (tenant_id, code, community_id, created) VALUES (?, ?, ?, ?)',
      [tenantId, code, req.params.id, new Date().toISOString()]
    );
    await saveDB();
    res.json({ success: true, code, community_id: req.params.id });
  } catch (error) {
    fail(res, error);
  }
});

// GET /api/communities/:id/invite-code
router.get('/:id/invite-code', requireAuth, requireAdmin, (req, res) => {
  try {
    const tenantId = tenantIdFrom(req);
    const community = findTenantRow(getDB(), 'communities', 'id', req.params.id, tenantId);
    if (!community) {
      return res.status(404).json({ error: '小区不存在', code: 'COMMUNITY_NOT_FOUND' });
    }
    const row = queryOne(
      'SELECT * FROM invite_codes WHERE tenant_id = ? AND community_id = ?',
      [tenantId, req.params.id]
    );
    if (!row) return res.json({ code: null });
    res.json({ code: row.code, community_id: row.community_id });
  } catch (error) {
    fail(res, error);
  }
});

module.exports = router;
