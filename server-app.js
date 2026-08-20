const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { verifyToken, requireAuth, requireAdmin, requireTenantUser } = require('./middleware/auth');
const { getPersistenceStatus } = require('./services/persistence-status');

const authRoutes = require('./routes/auth');
const ticketRoutes = require('./routes/tickets');
const communityRoutes = require('./routes/communities');
const staffRoutes = require('./routes/staff');
const settingsRoutes = require('./routes/settings');
const profileRoutes = require('./routes/profiles');
const shiftRoutes = require('./routes/shifts');
const attendanceRoutes = require('./routes/attendance');
const workforceReportRoutes = require('./routes/workforce-reports');
const directoryRoutes = require('./routes/directory');
const { createAiReportRouter } = require('./routes/ai-reports');

function isEnterpriseGateExempt(pathname) {
  return ['/platform', '/enterprise-applications'].some(prefix => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

function requireEnterpriseAccount(req, res, next) {
  if (isEnterpriseGateExempt(req.path)) return next();
  return requireAuth(req, res, () => requireTenantUser(req, res, next));
}

function createServerApp(options = {}) {
  const app = express();
  const configuredOrigins = String(process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  app.use(cors({
    // 同源部署不需要跨域；只有显式配置的前端域名才允许 CORS。
    origin: configuredOrigins.length ? configuredOrigins : false,
    credentials: false,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(verifyToken);

  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: '请求过于频繁，请稍后再试' },
  });
  app.use('/api/login', loginLimiter);
  app.use('/api/register', loginLimiter);
  app.use('/api/reset-password', loginLimiter);

  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', requireAuth, requireTenantUser, (req, res, next) => {
    let ticketId = '';
    try {
      ticketId = decodeURIComponent(String(req.path || '').split('/').filter(Boolean)[0] || '');
    } catch (_) {
      return res.status(404).json({ error: '附件不存在' });
    }
    if (!ticketId || !ticketRoutes.canAccessTicket(req, ticketId)) {
      return res.status(404).json({ error: '附件不存在' });
    }
    next();
  }, express.static(config.UPLOAD_DIR));

  app.use('/api', authRoutes);
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'property-oa' });
  });
  app.use('/api', requireEnterpriseAccount);
  app.use('/api/tickets', ticketRoutes);
  app.use('/api/communities', communityRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api', directoryRoutes);
  app.use('/api', settingsRoutes);
  app.use('/api', profileRoutes);
  app.use('/api', shiftRoutes);
  app.use('/api', attendanceRoutes);
  app.use('/api', workforceReportRoutes);
  app.use('/api', createAiReportRouter(options.aiReport));
  app.get('/api/persistence/status', requireAuth, requireAdmin, (req, res) => {
    res.json({ data: getPersistenceStatus() });
  });

  return app;
}

module.exports = { createServerApp, isEnterpriseGateExempt, requireEnterpriseAccount };
