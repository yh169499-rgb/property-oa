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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  PORT: process.env.PORT || 3001,
  NOTIFY_WEBHOOK: process.env.NOTIFY_WEBHOOK || '',
  DB_PATH: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data.db'),
  UPLOAD_DIR: process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads'),

  // Supabase Storage 持久化（仅服务端使用 service role key）
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || 'property-oa-data',
  SUPABASE_DB_OBJECT: process.env.SUPABASE_DB_OBJECT || 'production/data.db',
  SUPABASE_BACKUP_PREFIX: process.env.SUPABASE_BACKUP_PREFIX || 'backups',
  SUPABASE_SYNC_REQUIRED: String(process.env.SUPABASE_SYNC_REQUIRED || '').toLowerCase() === 'true',

  // AI 人员报告（服务端调用 OpenAI 兼容接口）
  AI_REPORT_ENABLED: String(process.env.AI_REPORT_ENABLED || '').toLowerCase() === 'true',
  AI_BASE_URL: String(process.env.AI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    .replace(/\/+$/, ''),
  AI_API_KEY: process.env.AI_API_KEY || '',
  AI_MODEL: process.env.AI_MODEL || 'qwen3.6-flash',
  AI_TIMEOUT_MS: positiveInteger(process.env.AI_TIMEOUT_MS, 30000),
  AI_REPORT_PROMPT_VERSION: process.env.AI_REPORT_PROMPT_VERSION || 'report-analysis-v1',

  // JWT
  // 生产环境必须通过 JWT_SECRET 注入；仅保留无敏感信息的本地开发占位值。
  JWT_SECRET: process.env.JWT_SECRET || 'local-development-only',
  JWT_EXPIRES: '7d',
  JWT_EXPIRES_LONG: '30d',

  // 句子秒懂
  JZMM_BASE_URL: 'https://stride-md.dpclouds.com',
  JZMM_ACCESS_KEY_ID: process.env.JZMM_ACCESS_KEY_ID || '',
  JZMM_ACCESS_KEY_SECRET: process.env.JZMM_ACCESS_KEY_SECRET || '',
  JZMM_BOT_ID: process.env.JZMM_BOT_ID || '',
  JZMM_EVENT_ID: process.env.JZMM_EVENT_ID || '',
  JZMM_SESSION_ID: process.env.JZMM_SESSION_ID || '',
  JZMM_ALERT_SESSION_ID: process.env.JZMM_ALERT_SESSION_ID || process.env.JZMM_SESSION_ID || '',
  JZMM_MSG_TOKEN: process.env.JZMM_MSG_TOKEN || '',
  // 外部建单入口的独立入站令牌；不得复用消息发送 Token。
  JZMM_INGEST_TOKEN: process.env.JZMM_INGEST_TOKEN || '',
  JZMM_IM_BOT_ID: process.env.JZMM_IM_BOT_ID || '',
  JZMM_ALERT_ROOM_ID: process.env.JZMM_ALERT_ROOM_ID || '',
  JZMM_MANAGER_CONTACT_ID: process.env.JZMM_MANAGER_CONTACT_ID || '',
  JZMM_CONTACT_MAP_JSON: process.env.JZMM_CONTACT_MAP_JSON || '{}',
  JZMM_MSG_BASE_URL: process.env.JZMM_MSG_BASE_URL || 'https://ae-mh.ddregion.com',

  // SLA 阈值（小时）
  SLA_THRESHOLDS: { urgent: 2, high: 8, normal: 24, low: 48 },
};
