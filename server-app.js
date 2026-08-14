const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { verifyToken, requireAuth, requireAdmin } = require('./middleware/auth');
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

// Express 4 不会自动把 async 路由的 Promise rejection 交给 error middleware。
// 统一包装路由处理器，避免数据库/外部服务异常时请求悬挂或触发 unhandledRejection。
function asyncHandler(handler) {
  return function wrappedAsyncHandler(req, res, next) {
    try {
      return Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

function wrapRouterAsync(router) {
  if (!router || !Array.isArray(router.stack)) return router;
  router.stack.forEach((layer) => {
    if (!layer.route || !Array.isArray(layer.route.stack)) return;
    layer.route.stack.forEach((routeLayer) => {
      if (typeof routeLayer.handle === 'function') {
        routeLayer.handle = asyncHandler(routeLayer.handle);
      }
    });
  });
  return router;
}

function createServerApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
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
  app.use('/uploads', requireAuth, (req, res, next) => {
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

  app.use('/api', wrapRouterAsync(authRoutes));
  app.use('/api/tickets', wrapRouterAsync(ticketRoutes));
  app.use('/api/communities', wrapRouterAsync(communityRoutes));
  app.use('/api/staff', wrapRouterAsync(staffRoutes));
  app.use('/api', wrapRouterAsync(directoryRoutes));
  app.use('/api', wrapRouterAsync(settingsRoutes));
  app.use('/api', wrapRouterAsync(profileRoutes));
  app.use('/api', wrapRouterAsync(shiftRoutes));
  app.use('/api', wrapRouterAsync(attendanceRoutes));
  app.use('/api', wrapRouterAsync(workforceReportRoutes));
  app.use('/api', wrapRouterAsync(createAiReportRouter(options.aiReport)));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'property-oa' });
  });
  app.get('/api/persistence/status', requireAuth, requireAdmin, (req, res) => {
    res.json({ data: getPersistenceStatus() });
  });

  // 统一处理上传器和其他未捕获错误，避免 Express 在开发模式返回堆栈和文件路径。
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '上传文件过大', code: 'UPLOAD_TOO_LARGE' });
    }
    if (error && /仅支持图片或 PDF|工单编号不合法/.test(String(error.message || ''))) {
      return res.status(400).json({ error: error.message, code: 'INVALID_UPLOAD' });
    }
    return res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
  });

  return app;
}

module.exports = { createServerApp, asyncHandler, wrapRouterAsync };
