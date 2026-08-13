const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const database = require('../db');
const config = require('../config');
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

  function backupDatabase() {
    if (typeof options.backup === 'function') return options.backup();
    const source = path.resolve(config.DB_PATH);
    if (!fs.existsSync(source)) throw new Error('生产数据库文件不存在');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${source}.before-retained-${stamp}.db`;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(target, 0o600); } catch (_) { /* 文件系统可能不支持 chmod */ }
    return path.basename(target);
  }

  router.post('/admin/mock-data/apply', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body || {};
    const requestPassword = password || String(body.password || '');
    const configuredTokenAccepted = token && safeEqual(body.token, token);
    const explicitConfirmationAccepted = !token
      && safeEqual(body.confirm, 'RETAINED-TEST-DATA')
      && requestPassword.length >= 10;
    if (!requestPassword || (!configuredTokenAccepted && !explicitConfirmationAccepted)) {
      return res.status(403).json({ error: '一次性部署凭据无效', code: 'MOCK_DATA_DEPLOY_FORBIDDEN' });
    }
    try {
      const backup = await backupDatabase();
      const migration = migrateRetainedTestData(database.getDB(), {
        password: requestPassword,
        now: options.now || new Date(),
      });
      await database.saveDB();
      return res.json({ data: { ...migration, backup } });
    } catch (error) {
      return res.status(500).json({ error: '模拟数据写入失败', code: 'MOCK_DATA_DEPLOY_FAILED' });
    }
  });

  return router;
}

module.exports = { createDeploymentRouter, safeEqual };
