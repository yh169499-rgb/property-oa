/**
 * 配置 & 环境变量
 */
const path = require('path');
const fs = require('fs');

// 加载 .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length && process.env[key.trim()] === undefined) {
      process.env[key.trim()] = val.join('=').trim();
    }
  });
}

module.exports = {
  PORT: process.env.PORT || 3001,
  NOTIFY_WEBHOOK: process.env.NOTIFY_WEBHOOK || '',
  DB_PATH: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data.db'),
  UPLOAD_DIR: process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads'),

  // JWT
  // 生产环境必须通过 JWT_SECRET 注入；仅保留无敏感信息的本地开发占位值。
  JWT_SECRET: process.env.JWT_SECRET || 'local-development-only',
  JWT_EXPIRES: '7d',
  JWT_EXPIRES_LONG: '30d',

  // 句子秒懂
  JZMM_BASE_URL: 'https://stride-md.dpclouds.com',
  JZMM_ACCESS_KEY_ID: process.env.JZMM_ACCESS_KEY_ID || '',
  JZMM_ACCESS_KEY_SECRET: process.env.JZMM_ACCESS_KEY_SECRET || '',
  JZMM_BOT_ID: process.env.JZMM_BOT_ID || '449022b0-ff71-4f47-b8b4-2eac094c575e',
  JZMM_EVENT_ID: process.env.JZMM_EVENT_ID || 'a277efc6-025f-41cd-8888-43e3a8e8e28f',
  JZMM_SESSION_ID: process.env.JZMM_SESSION_ID || '6a5a19ebce406a6aee929fe0',
  JZMM_ALERT_SESSION_ID: process.env.JZMM_ALERT_SESSION_ID || process.env.JZMM_SESSION_ID || '6a5a19ebce406a6aee929fe0',
  JZMM_MSG_TOKEN: process.env.JZMM_MSG_TOKEN || '',
  JZMM_IM_BOT_ID: process.env.JZMM_IM_BOT_ID || '6a5a1834766986bb5adc5761',
  JZMM_ALERT_ROOM_ID: process.env.JZMM_ALERT_ROOM_ID || 'R:10856729056671822',
  JZMM_MANAGER_CONTACT_ID: process.env.JZMM_MANAGER_CONTACT_ID || '7881302262050947',

  // SLA 阈值（小时）
  SLA_THRESHOLDS: { urgent: 2, high: 8, normal: 24, low: 48 },
};