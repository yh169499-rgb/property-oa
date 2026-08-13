const crypto = require('node:crypto');
const express = require('express');
const database = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { migrateRetainedTestData } = require('../services/retained-test-data');

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createDeploymentRouter(options = {}) {
  const router = express.Router();
  const configured = options.token != null || options.password != null;
  const token = configured ? String(options.token || '') : String(process.env.MOCK_DATA_DEPLOY_TOKEN || '');
  const password = configured ? String(options.password || '') : String(process.env.RETAINED_TEST_PASSWORD || '');

  router.post('/admin/mock-data/apply', requireAuth, requireAdmin, async (req, res) => {
    if (!token || !password || !safeEqual(req.body && req.body.token, token)) {
      return res.status(403).json({ error: '一次性部署凭据无效', code: 'MOCK_DATA_DEPLOY_FORBIDDEN' });
    }
    try {
      const migration = migrateRetainedTestData(database.getDB(), {
        password,
        now: options.now || new Date(),
      });
      await database.saveDB();
      return res.json({ data: migration });
    } catch (error) {
      return res.status(500).json({ error: '模拟数据写入失败', code: 'MOCK_DATA_DEPLOY_FAILED' });
    }
  });

  return router;
}

module.exports = { createDeploymentRouter, safeEqual };

