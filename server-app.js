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

function createServerApp(options = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());
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
  app.use('/uploads', express.static(config.UPLOAD_DIR));

  app.use('/api', authRoutes);
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

module.exports = { createServerApp };
