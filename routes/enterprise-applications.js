const express = require('express');

const database = require('../db');
const { asyncHandler } = require('../middleware/async-handler');
const { submitEnterpriseApplication } = require('../services/enterprise-applications');

const router = express.Router();

// 申请只允许公开提交；列表与详情不属于企业端 API，避免未登录请求被
// 后续企业鉴权中间件误报为 401。
router.get('/enterprise-applications', (_req, res) => {
  res.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' });
});

router.post('/enterprise-applications', asyncHandler(async (req, res) => {
  const application = await submitEnterpriseApplication(database.getDB(), req.body);
  await database.saveDB();
  res.status(201).json({
    success: true,
    data: { id: application.id, status: application.status },
  });
}));

module.exports = router;
