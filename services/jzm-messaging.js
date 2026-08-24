const fetch = require('node-fetch');
const config = require('../config');
const { queryAll, queryOne } = require('../db');

const ALERT_SETTING_KEY = 'jzm_alert_config';
let testSender = null;

function tableExists(db, name) {
  return Boolean(db?.exec?.("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name])?.[0]?.values?.length);
}

function dbQueryOne(db, sql, params = []) {
  if (!db?.prepare) return queryOne(sql, params);
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function parseContactMap(value) {
  const parsed = typeof value === 'string' ? parseJson(value, {}) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed)
    .map(([key, contactId]) => [String(key).trim(), String(contactId || '').trim()])
    .filter(([key, contactId]) => key && contactId));
}

function getEnvConfig() {
  return {
    roomId: String(config.JZMM_ALERT_ROOM_ID || '').trim(),
    imBotId: String(config.JZMM_IM_BOT_ID || '').trim(),
    managerContactId: String(config.JZMM_MANAGER_CONTACT_ID || '').trim(),
    contactMap: parseContactMap(config.JZMM_CONTACT_MAP_JSON),
    msgToken: String(config.JZMM_MSG_TOKEN || '').trim(),
    baseUrl: String(config.JZMM_MSG_BASE_URL || 'https://open.dpclouds.com').replace(/\/+$/, ''),
  };
}

function getStoredConfig(db, tenantId) {
  if (!tenantId || !tableExists(db, 'tenant_settings')) return {};
  const row = dbQueryOne(db, `SELECT value, updated_at FROM tenant_settings
    WHERE tenant_id = ? AND key = ?`, [tenantId, ALERT_SETTING_KEY]);
  if (!row) return {};
  const value = parseJson(row.value, {});
  return { ...value, updatedAt: row.updated_at || '' };
}

function getTenantAlertConfig(db, tenantId) {
  const environment = getEnvConfig();
  const stored = getStoredConfig(db, tenantId);
  return {
    roomId: String(stored.roomId || environment.roomId).trim(),
    imBotId: String(stored.imBotId || environment.imBotId).trim(),
    managerContactId: String(stored.managerContactId || environment.managerContactId).trim(),
    contactMap: { ...environment.contactMap, ...parseContactMap(stored.contactMap) },
    msgToken: environment.msgToken,
    baseUrl: environment.baseUrl,
    updatedAt: stored.updatedAt || '',
  };
}

function publicTenantAlertConfig(db, tenantId) {
  const value = getTenantAlertConfig(db, tenantId);
  return {
    roomId: value.roomId,
    imBotId: value.imBotId,
    managerContactIdConfigured: Boolean(value.managerContactId),
    contactCount: Object.keys(value.contactMap).length,
    tokenConfigured: Boolean(value.msgToken),
    updatedAt: value.updatedAt,
  };
}

function saveTenantAlertConfig(db, tenantId, input, now = new Date().toISOString()) {
  if (!tableExists(db, 'tenant_settings')) throw new Error('租户配置表尚未初始化');
  const roomId = String(input.roomId || '').trim();
  const imBotId = String(input.imBotId || '').trim();
  const managerContactId = String(input.managerContactId || '').trim();
  if (!roomId || !imBotId || !managerContactId) {
    const error = new Error('roomId、imBotId、managerContactId 均不能为空');
    error.code = 'JZM_ALERT_CONFIG_INVALID';
    error.status = 400;
    throw error;
  }
  const contactMap = parseContactMap(input.contactMap);
  if (Object.keys(contactMap).length > 100) {
    const error = new Error('联系人映射不能超过 100 条');
    error.code = 'JZM_ALERT_CONFIG_INVALID';
    error.status = 400;
    throw error;
  }
  const value = JSON.stringify({ roomId, imBotId, managerContactId, contactMap });
  db.run(`INSERT INTO tenant_settings(tenant_id,key,value,created_at,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  [tenantId, ALERT_SETTING_KEY, value, now, now]);
  return publicTenantAlertConfig(db, tenantId);
}

function contactIdFor(configured, candidate) {
  if (!candidate) return '';
  const values = [candidate.contactId, candidate.name, candidate.displayName, candidate.phone, candidate.userId]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
    .map(value => String(value).trim());
  for (const value of values) {
    if (configured.contactMap[value]) return configured.contactMap[value];
  }
  return '';
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function metadataFor(ticket) {
  const metadata = parseJson(ticket?.metadata, {});
  return {
    feedbackPerson: ticket?.feedbackPerson || metadata.feedbackPerson || metadata.feedback_person || '',
    feedbackGroup: ticket?.feedbackGroup || metadata.feedbackGroup || metadata.feedback_group || '',
    originalMessage: ticket?.originalMessage || metadata.originalMessage || metadata.original_message || '',
  };
}

function formatTicketAlert(kind, ticket, actor, assignee) {
  const meta = metadataFor(ticket);
  const reporter = meta.feedbackPerson || actor?.name || '系统';
  const group = meta.feedbackGroup || ticket?.sessionId || '工单系统';
  const original = meta.originalMessage || ticket?.message || ticket?.desc || '';
  const worker = ticket?.worker || assignee?.displayName || '未指定';
  if (kind === 'completed') {
    return `————工单完结提醒————\n时段：${formatTime(ticket?.finished || new Date().toISOString())}\n工单号：${ticket?.id || ''}\n反馈事件：${ticket?.cat || '其他'}\n处理人：${worker}\n原文消息：${original}\n———！！已处理完毕！！———`;
  }
  if (kind === 'waiting') {
    return `主管待派单${ticket?.count ? `，当前还有 ${ticket.count} 张工单待派单，请尽快处理。` : ''}`;
  }
  return `————紧急消息提醒————\n时段：${formatTime(ticket?.created || new Date().toISOString())}\n反馈人：${reporter}\n反馈群：${group}\n反馈事件：${ticket?.cat || '其他'}\n反馈原因：${ticket?.message || ticket?.desc || ''}\n原文消息：${original}\n———！！请注意留意！！———`;
}

async function sendMessage(configured, text, mentionContactIds = []) {
  const body = {
    imBotId: configured.imBotId,
    imRoomId: configured.roomId,
    messageType: 7,
    payload: { text, mentionContactIds: [...new Set(mentionContactIds.filter(Boolean))] },
  };
  const request = {
    url: `${configured.baseUrl}/api/v2/message/send?token=${encodeURIComponent(configured.msgToken)}`,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
  // 测试注入器不依赖生产 Token，仍返回完整的请求体供断言。
  if (testSender) return testSender(request);
  if (!configured.msgToken || !configured.roomId || !configured.imBotId) {
    return { success: false, skipped: true, error: '秒回预警配置不完整' };
  }
  try {
    const response = await fetch(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && Number(result.errcode) === 0) return { success: true, data: result };
    console.warn('[秒回预警] 消息发送失败:', JSON.stringify(result));
    return { success: false, error: result };
  } catch (error) {
    console.warn('[秒回预警] 网络错误:', error.message);
    return { success: false, error: error.message };
  }
}

async function sendTicketAlert({ db, tenantId, kind, ticket, actor, assignee }) {
  const configured = getTenantAlertConfig(db, tenantId);
  const contact = kind === 'completed'
    ? contactIdFor(configured, assignee || { name: ticket?.worker })
    : kind === 'created' || kind === 'assigned'
      ? contactIdFor(configured, assignee) || configured.managerContactId
      : configured.managerContactId;
  const text = formatTicketAlert(kind, ticket, actor, assignee);
  return sendMessage(configured, text, [contact]);
}

async function sendWaitingTicketsAlert({ db, tenantId, count }) {
  const configured = getTenantAlertConfig(db, tenantId);
  return sendMessage(configured, formatTicketAlert('waiting', { count }), [configured.managerContactId]);
}

function setMessageSenderForTests(sender) { testSender = sender; }
function resetMessageSenderForTests() { testSender = null; }

module.exports = {
  ALERT_SETTING_KEY,
  getTenantAlertConfig,
  publicTenantAlertConfig,
  saveTenantAlertConfig,
  sendTicketAlert,
  sendWaitingTicketsAlert,
  formatTicketAlert,
  setMessageSenderForTests,
  resetMessageSenderForTests,
};
