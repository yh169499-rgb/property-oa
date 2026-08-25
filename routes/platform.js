const express = require('express');
const bcrypt = require('bcryptjs');

const database = require('../db');
const { generateToken, requireAuth, requirePlatformOwner } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/async-handler');
const {
  approveEnterpriseApplication,
  rejectEnterpriseApplication,
  listEnterpriseApplications,
} = require('../services/enterprise-applications');
const {
  listTenants,
  updateTenant,
  setTenantStatus,
  resetTenantSupervisorPassword,
  getPlatformOverview,
  listPlatformAuditLogs,
} = require('../services/platform-tenants');
const {
  listDataTables,
  listDataRows,
  updateDataRow,
  deleteDataRow,
} = require('../services/platform-data-center');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const password = String(req.body?.password || '');
  const user = phone ? database.queryOne('SELECT * FROM users WHERE phone=?', [phone]) : null;
  const eligible = user
    && user.role === 'platform_owner'
    && !user.tenant_id
    && String(user.status || '') === 'active';
  const valid = eligible && await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: '平台账号或密码错误', code: 'INVALID_PLATFORM_CREDENTIALS' });
  }
  const nowIso = new Date().toISOString();
  database.run('UPDATE users SET last_login_at=? WHERE id=?', [nowIso, user.id]);
  try {
    await database.saveDB();
  } catch (error) {
    database.run('UPDATE users SET last_login_at=? WHERE id=?', [user.last_login_at ?? null, user.id]);
    throw error;
  }
  res.json({
    success: true,
    data: {
      token: generateToken(user, false),
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
    },
  });
}));

router.use(requireAuth, requirePlatformOwner);

router.get('/overview', (req, res) => {
  res.json({ data: getPlatformOverview(database.getDB(), req.user) });
});

router.get('/applications', (req, res) => {
  res.json({ data: listEnterpriseApplications(database.getDB(), req.user) });
});

router.post('/applications/:id/approve', asyncHandler(async (req, res) => {
  const result = approveEnterpriseApplication(database.getDB(), req.params.id, req.user, {
    staffLimit: req.body?.staffLimit,
  });
  await database.saveDB();
  res.json({ success: true, data: result });
}));

router.post('/applications/:id/reject', asyncHandler(async (req, res) => {
  const result = rejectEnterpriseApplication(database.getDB(), req.params.id, req.user, {
    reason: req.body?.reason,
  });
  await database.saveDB();
  res.json({ success: true, data: result });
}));

router.get('/tenants', (req, res) => {
  res.json({ data: listTenants(database.getDB(), req.user) });
});

router.get('/tenants/:tenantId/data-tables', (req, res) => {
  res.json({ data: listDataTables(database.getDB(), req.user, req.params.tenantId) });
});

router.get('/tenants/:tenantId/data/:table', (req, res) => {
  res.json({ data: listDataRows(database.getDB(), req.user, req.params.tenantId, req.params.table, req.query) });
});

router.patch('/tenants/:tenantId/data/:table/:id', asyncHandler(async (req, res) => {
  const result = updateDataRow(
    database.getDB(),
    req.user,
    req.params.tenantId,
    req.params.table,
    req.params.id,
    req.body,
  );
  await database.saveDB();
  res.json({ success: true, data: result });
}));

router.delete('/tenants/:tenantId/data/:table/:id', (req, res) => {
  deleteDataRow(database.getDB(), req.user, req.params.tenantId, req.params.table, req.params.id);
  res.status(405).json({ error: '管理平台数据中心不允许删除数据', code: 'PLATFORM_DATA_DELETE_FORBIDDEN' });
});

router.patch('/tenants/:id', asyncHandler(async (req, res) => {
  const input = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) input.name = req.body.name;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'staffLimit')) input.staffLimit = req.body.staffLimit;
  const result = updateTenant(database.getDB(), req.params.id, req.user, input);
  await database.saveDB();
  res.json({ success: true, data: result });
}));

router.post('/tenants/:id/disable', asyncHandler(async (req, res) => {
  const result = setTenantStatus(database.getDB(), req.params.id, req.user, 'disabled');
  await database.saveDB();
  res.json({ success: true, data: result });
}));

router.post('/tenants/:id/restore', asyncHandler(async (req, res) => {
  const result = setTenantStatus(database.getDB(), req.params.id, req.user, 'active');
  await database.saveDB();
  res.json({ success: true, data: result });
}));

router.post('/tenants/:id/reset-supervisor-password', asyncHandler(async (req, res) => {
  const result = await resetTenantSupervisorPassword(database.getDB(), req.params.id, req.user, {
    password: req.body?.password,
  });
  await database.saveDB();
  res.json({ success: true, data: result });
}));

router.get('/audit-logs', (req, res) => {
  res.json({ data: listPlatformAuditLogs(database.getDB(), req.user, { limit: req.query.limit }) });
});

module.exports = router;
