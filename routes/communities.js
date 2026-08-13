/**
 * 小区管理路由
 */
const express = require('express');
const router = express.Router();
const { queryAll, queryOne, run, saveDB } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { isSupervisorUser } = require('../services/roles');

function syncMemberships(communityId, allowedStaff) {
  run('DELETE FROM community_memberships WHERE community_id = ?', [communityId]);
  if (!Array.isArray(allowedStaff)) return;
  for (const name of allowedStaff) {
    const matches = queryAll(
      `SELECT id FROM staff_profiles
        WHERE TRIM(name) = TRIM(?) AND COALESCE(employment_status, 'active') = 'active'`,
      [String(name || '')]
    );
    if (matches.length === 1) {
      run(
        'INSERT OR IGNORE INTO community_memberships (community_id, staff_profile_id, created_at) VALUES (?, ?, ?)',
        [communityId, matches[0].id, new Date().toISOString()]
      );
    }
  }
}

// GET /api/communities (登录后按小区成员范围返回)
router.get('/', requireAuth, (req, res) => {
  const staffName = req.query.staff_name;
  const supervisor = isSupervisorUser(req.user);
  let communities;
  if (supervisor && staffName) {
    communities = queryAll(
      `SELECT DISTINCT c.* FROM communities c
       LEFT JOIN community_permissions cp ON c.id = cp.community_id
       WHERE c.id = 'default' OR cp.staff_name = ?
       ORDER BY c.created ASC`, [staffName]
    );
  } else if (supervisor) {
    communities = queryAll('SELECT * FROM communities ORDER BY created ASC');
  } else {
    communities = queryAll(
      `SELECT DISTINCT c.* FROM communities c
       LEFT JOIN community_permissions cp ON c.id = cp.community_id
       LEFT JOIN community_memberships cm ON c.id = cm.community_id
       LEFT JOIN staff_profiles sp ON sp.id = cm.staff_profile_id
       WHERE c.id = 'default' OR cp.staff_name = ? OR sp.user_id = ?
       ORDER BY c.created ASC`, [req.user.name, req.user.id]
    );
  }
  communities.forEach(c => {
    c.allowedStaff = supervisor
      ? queryAll('SELECT staff_name FROM community_permissions WHERE community_id = ?', [c.id]).map(r => r.staff_name)
      : [];
  });
  res.json({ data: communities });
});

// POST /api/communities (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { name, address, allowedStaff } = req.body;
  if (!name) return res.status(400).json({ error: '小区名称必填' });
  const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();
  try {
    run('INSERT INTO communities (id, name, address, created) VALUES (?, ?, ?, ?)', [id, name, address || '', now]);
    if (allowedStaff && Array.isArray(allowedStaff)) {
      allowedStaff.forEach(s => run('INSERT OR IGNORE INTO community_permissions (community_id, staff_name) VALUES (?, ?)', [id, s]));
      syncMemberships(id, allowedStaff);
    }
    await saveDB();
    res.json({ success: true, community: { id, name, address: address || '', created: now, allowedStaff: allowedStaff || [] } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/communities/:id (admin only)
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, address, allowedStaff } = req.body;
  const sets = [], values = [];
  if (name !== undefined) { sets.push('name = ?'); values.push(name); }
  if (address !== undefined) { sets.push('address = ?'); values.push(address); }
  if (sets.length) { values.push(req.params.id); run(`UPDATE communities SET ${sets.join(', ')} WHERE id = ?`, values); }
  if (allowedStaff !== undefined && Array.isArray(allowedStaff)) {
    run('DELETE FROM community_permissions WHERE community_id = ?', [req.params.id]);
    allowedStaff.forEach(s => run('INSERT OR IGNORE INTO community_permissions (community_id, staff_name) VALUES (?, ?)', [req.params.id, s]));
    syncMemberships(req.params.id, allowedStaff);
  }
  await saveDB();
  const row = queryOne('SELECT * FROM communities WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: '小区不存在' });
  row.allowedStaff = queryAll('SELECT staff_name FROM community_permissions WHERE community_id = ?', [req.params.id]).map(r => r.staff_name);
  res.json({ success: true, community: row });
});

// DELETE /api/communities/:id (admin only)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === 'default') return res.status(400).json({ error: '默认小区不能删除' });
  run("UPDATE tickets SET community_id = 'default' WHERE community_id = ?", [req.params.id]);
  run('DELETE FROM communities WHERE id = ?', [req.params.id]);
  run('DELETE FROM community_memberships WHERE community_id = ?', [req.params.id]);
  await saveDB();
  res.json({ success: true });
});

// POST /api/communities/:id/invite-code (admin only)
router.post('/:id/invite-code', requireAuth, requireAdmin, async (req, res) => {
  const communityId = req.params.id;
  const community = queryOne('SELECT * FROM communities WHERE id = ?', [communityId]);
  if (!community) return res.status(404).json({ error: '小区不存在' });
  let existing = queryOne('SELECT * FROM invite_codes WHERE community_id = ?', [communityId]);
  if (existing) return res.json({ success: true, code: existing.code, community_id: communityId });
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  run('INSERT INTO invite_codes (code, community_id, created) VALUES (?, ?, ?)', [code, communityId, new Date().toISOString()]);
  await saveDB();
  res.json({ success: true, code, community_id: communityId });
});

// GET /api/communities/:id/invite-code
router.get('/:id/invite-code', requireAuth, requireAdmin, (req, res) => {
  const row = queryOne('SELECT * FROM invite_codes WHERE community_id = ?', [req.params.id]);
  if (!row) return res.json({ code: null });
  res.json({ code: row.code, community_id: row.community_id });
});

module.exports = router;
