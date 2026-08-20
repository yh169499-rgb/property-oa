const express = require('express');
const { queryAll, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isSupervisorUser } = require('../services/roles');
const { tenantIdFrom } = require('../services/tenant-context');

const router = express.Router();

function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code });
}

router.get('/staff/directory', requireAuth, (req, res) => {
  let tenantId;
  try {
    tenantId = tenantIdFrom(req);
  } catch (error) {
    return fail(res, error.status || 403, error.message, error.code);
  }
  const communityId = String(req.query.community_id || req.query.communityId || '').trim();
  if (!communityId) return fail(res, 400, '必须指定小区', 'COMMUNITY_REQUIRED');
  const community = queryOne(
    'SELECT id, name FROM communities WHERE id = ? AND tenant_id = ?',
    [communityId, tenantId]
  );
  if (!community) return fail(res, 404, '小区不存在', 'COMMUNITY_NOT_FOUND');

  const own = queryOne(
    'SELECT id, employment_status FROM staff_profiles WHERE user_id = ? AND tenant_id = ?',
    [req.user.id, tenantId]
  );
  if (!own) return fail(res, 404, '人员档案不存在', 'PROFILE_NOT_FOUND');
  const globalManager = isSupervisorUser(req.user);
  if (!globalManager) {
    const member = queryOne(
      `SELECT 1 FROM community_memberships
        WHERE tenant_id = ? AND community_id = ? AND staff_profile_id = ?`,
      [tenantId, communityId, own.id]
    );
    if (!member) return fail(res, 403, '无权查看该小区通讯录', 'DIRECTORY_SCOPE_FORBIDDEN');
  }

  const data = queryAll(
    `SELECT sp.id, sp.name, sp.position, sp.skill, sp.phone
       FROM community_memberships cm
       JOIN staff_profiles sp
         ON sp.id = cm.staff_profile_id AND sp.tenant_id = cm.tenant_id
      WHERE cm.tenant_id = ? AND cm.community_id = ?
        AND COALESCE(sp.employment_status, 'active') = 'active'
      ORDER BY sp.id`,
    [tenantId, communityId]
  );
  res.json({ data, community });
});

module.exports = router;
