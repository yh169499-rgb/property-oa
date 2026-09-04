const fetch = require('node-fetch');
const config = require('../config');
const { queryAll, queryOne } = require('../db');

const ALERT_SETTING_KEY = 'jzm_alert_config';
const DEFAULT_MSG_BASE_URL = 'https://ae-bg.ddregion.com/hub-api';
const LEGACY_MSG_BASE_URLS = new Set([
  'https://open.dpclouds.com',
  'https://ae-mh.ddregion.com',
  'https://test-aa-hub.ddregion.com',
]);
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
  const configuredBaseUrl = String(config.JZMM_MSG_BASE_URL || '').trim().replace(/\/+$/, '');
  return {
    msgToken: String(config.JZMM_MSG_TOKEN || '').trim(),
    // Render 旧服务可能仍保存旧环境变量；自动迁移，避免继续请求已失效域名。
    baseUrl: !configuredBaseUrl || LEGACY_MSG_BASE_URLS.has(configuredBaseUrl)
      ? DEFAULT_MSG_BASE_URL
      : configuredBaseUrl,
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
    // 群、机器人和联系人必须按租户配置，禁止使用跨租户环境默认值回退。
    roomId: String(stored.roomId || '').trim(),
    imBotId: String(stored.imBotId || '').trim(),
    managerContactId: String(stored.managerContactId || '').trim(),
    contactMap: parseContactMap(stored.contactMap),
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

function cleanMessageText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = parseJson(text, null);
  if (parsed && !Array.isArray(parsed)) {
    return String(parsed['整理消息'] || parsed.message || parsed.content || '').trim();
  }
  return text;
}

function formatTicketAlert(kind, ticket, actor, assignee) {
  const meta = metadataFor(ticket);
  const reporter = String(meta.feedbackPerson || '').trim();
  const group = String(meta.feedbackGroup || '').trim();
  const reason = cleanMessageText(ticket?.desc || ticket?.message);
  const original = cleanMessageText(meta.originalMessage);
  const worker = ticket?.worker || assignee?.displayName || '未指定';
  if (kind === 'completed') {
    return `————工单完结提醒————\n工单号：${ticket?.id || ''}\n事件：${ticket?.cat || '其他'}\n地点：${ticket?.loc || '未填写'}\n处理人：${worker}\n状态：该工单已处理完成\n完成时间：${formatTime(ticket?.finished || new Date().toISOString())}\n————————————`;
  }
  if (kind === 'waiting') {
    return `主管待派单${ticket?.count ? `，当前还有 ${ticket.count} 张工单待派单，请尽快处理。` : ''}`;
  }
  if (kind === 'assigned') {
    return `————新的派单提醒————\n您有新的派单，请及时处理。\n工单号：${ticket?.id || ''}\n事件：${ticket?.cat || '其他'}\n地点：${ticket?.loc || '未填写'}\n————————————`;
  }
  if (kind === 'submitted') {
    return `————工单待确认提醒————\n处理人 ${worker} 已提交处理结果，等待您确认。\n工单号：${ticket?.id || ''}\n事件：${ticket?.cat || '其他'}\n地点：${ticket?.loc || '未填写'}\n————————————`;
  }
  if (kind === 'returned') {
    return `————工单退回提醒————\n处理人 ${actor?.name || worker} 已退回工单，请及时重新派单。\n工单号：${ticket?.id || ''}\n事件：${ticket?.cat || '其他'}\n地点：${ticket?.loc || '未填写'}\n————————————`;
  }
  if (kind === 'suspended') {
    return `————工单搁置提醒————\n处理人 ${actor?.name || worker} 已搁置工单，请及时跟进或重新派单。\n工单号：${ticket?.id || ''}\n事件：${ticket?.cat || '其他'}\n地点：${ticket?.loc || '未填写'}\n————————————`;
  }
  if (kind === 'overdue_worker') {
    return `————工单超时提醒————\n该工单已超过 ${ticket?.reminderIntervalMinutes || ''} 分钟未处理，请及时跟进。\n工单号：${ticket?.id || ''}\n事件：${ticket?.cat || '其他'}\n地点：${ticket?.loc || '未填写'}\n————————————`;
  }
  if (kind === 'overdue_manager') {
    const statusText = {
      wait: '待派单', pending: '搁置中', confirm: '待确认',
    }[ticket?.status] || '未处理';
    return `————工单超时提醒————\n该工单处于“${statusText}”状态已超过 ${ticket?.reminderIntervalMinutes || ''} 分钟，请及时处理。\n工单号：${ticket?.id || ''}\n事件：${ticket?.cat || '其他'}\n地点：${ticket?.loc || '未填写'}\n————————————`;
  }
  const lines = [
    '————紧急消息提醒————',
    `时段：${formatTime(ticket?.created || new Date().toISOString())}`,
  ];
  if (reporter) lines.push(`反馈人：${reporter}`);
  if (group) lines.push(`反馈群：${group}`);
  lines.push(`反馈事件：${ticket?.cat || '其他'}`);
  if (reason) lines.push(`反馈原因：${reason}`);
  if (original) lines.push(`原文消息：${original}`);
  lines.push('———！！请注意留意！！———');
  return lines.join('\n');
}

function safeIdentifier(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : '';
}

function messageFailure(code, details = {}) {
  const error = { code };
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) {
    error.httpStatus = details.httpStatus;
  }
  if (Number.isFinite(details.errcode)) {
    error.errcode = details.errcode;
  } else {
    const errcode = safeIdentifier(details.errcode);
    if (errcode) error.errcode = errcode;
  }
  const requestId = safeIdentifier(details.requestId);
  if (requestId) error.requestId = requestId;
  return { success: false, error };
}

function upstreamFailure(result, httpStatus) {
  const details = result?.error && typeof result.error === 'object' ? result.error : {};
  return messageFailure('JZM_MESSAGE_UPSTREAM_ERROR', {
    httpStatus: result?.httpStatus ?? details.httpStatus ?? httpStatus,
    errcode: result?.errcode ?? details.errcode,
    requestId: result?.requestId ?? details.requestId,
  });
}

function warnMessageFailure(label, failure) {
  console.warn(label, JSON.stringify(failure.error));
}

async function sendMessage(configured, text, mentionContactIds = []) {
  const mention = [...new Set(mentionContactIds.filter(Boolean))];
  const formattedText = mention.length ? `\n${text}` : text;
  const body = {
    imBotId: configured.imBotId,
    imRoomId: configured.roomId,
    messageType: 7,
    payload: { text: formattedText, mention },
  };
  const request = {
    url: `${configured.baseUrl}/api/v2/message/send?token=${encodeURIComponent(configured.msgToken)}`,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
  try {
    // 测试注入器与真实网络请求共享同一脱敏失败边界。
    if (testSender) {
      const result = await testSender(request);
      if (result?.success === false) {
        const failure = upstreamFailure(result);
        warnMessageFailure('[秒回预警] 消息发送失败:', failure);
        return failure;
      }
      return result;
    }
    if (!configured.msgToken || !configured.roomId || !configured.imBotId) {
      const failure = messageFailure('JZM_MESSAGE_CONFIG_INCOMPLETE');
      warnMessageFailure('[秒回预警] 未发送:', failure);
      return failure;
    }
    const response = await fetch(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && Number(result.errcode) === 0) {
      console.log('[秒回预警] 消息发送成功', JSON.stringify({
        requestId: safeIdentifier(result.requestId),
      }));
      return { success: true, data: result };
    }
    const failure = upstreamFailure(result, response.status);
    warnMessageFailure('[秒回预警] 消息发送失败:', failure);
    return failure;
  } catch (_) {
    const failure = messageFailure('JZM_MESSAGE_NETWORK_ERROR');
    warnMessageFailure('[秒回预警] 网络错误:', failure);
    return failure;
  }
}

async function sendTicketAlert({ db, tenantId, kind, ticket, actor, assignee }) {
  const configured = getTenantAlertConfig(db, tenantId);
  const isWorkerTarget = kind === 'assigned' || kind === 'overdue_worker'
    || (kind === 'created' && assignee);
  const contact = kind === 'completed'
    ? ''
    : isWorkerTarget
      ? contactIdFor(configured, assignee || { name: ticket?.worker })
      : configured.managerContactId;
  if (isWorkerTarget && !contact) {
    console.warn('[秒回预警] 未找到处理人 contactId，消息不降级 @主管:', JSON.stringify({
      code: 'JZM_CONTACT_NOT_CONFIGURED',
    }));
  }
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
