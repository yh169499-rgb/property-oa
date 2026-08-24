/**
 * 外部系统接入鉴权与企业归属解析。
 *
 * 外部 POST 不能直接传 tenant_id，也不能伪造登录用户；只允许携带企业名称，
 * 服务端按精确名称找到 active 企业及其主管，再在该租户上下文中处理请求。
 */
const crypto = require('crypto');
const config = require('../config');
const { queryAll, queryOne } = require('../db');

function integrationError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function timingSafeTokenMatch(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  if (!actualBuffer.length || actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function enterpriseNameFrom(body = {}) {
  return String(
    body.enterprise_name
      || body.enterpriseName
      || body.company_name
      || body.companyName
      || body.tenant_name
      || body.tenantName
      || ''
  ).trim();
}

function firstValue(body, keys) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && String(body[key]).trim() !== '') {
      return String(body[key]).trim();
    }
  }
  return '';
}

/**
 * 从外部建单请求中提取可选的企业秒回配置。
 * 一旦请求携带任意一个 ID，就要求同一请求携带完整的群/机器人/主管联系人信息，
 * 防止半套配置覆盖企业当前可用配置。
 */
function alertConfigFromBody(body = {}) {
  const roomId = firstValue(body, ['roomId', 'roomid', 'room_id']);
  const imBotId = firstValue(body, ['imBotId', 'imbotid', 'im_bot_id']);
  const managerContactId = firstValue(body, [
    'managerContactId', 'managerContactid', 'manager_contact_id',
    'contactId', 'contactid', 'contact_id',
  ]);
  const contactMap = body.contactMap || body.contact_map || body.contacts;
  if (!roomId && !imBotId && !managerContactId && contactMap === undefined) return null;
  if (!roomId || !imBotId || !managerContactId) {
    throw integrationError(400, 'JZM_ALERT_CONFIG_INVALID', '外部建单携带秒回配置时，roomId、imBotId、contactId 均不能为空');
  }
  return { roomId, imBotId, managerContactId, contactMap: contactMap || {} };
}

function resolveEnterprise(enterpriseName) {
  const name = String(enterpriseName || '').trim();
  if (!name) throw integrationError(400, 'ENTERPRISE_REQUIRED', '必须提供企业名称');
  const matches = queryAll(`SELECT id,name,status,owner_user_id
    FROM tenants WHERE lower(trim(name)) = lower(trim(?)) ORDER BY id`, [name]);
  if (!matches.length) throw integrationError(404, 'ENTERPRISE_NOT_FOUND', '企业不存在');
  if (matches.length > 1) throw integrationError(409, 'ENTERPRISE_AMBIGUOUS', '企业名称不唯一，请联系平台运维');
  const tenant = matches[0];
  if (String(tenant.status || '').toLowerCase() !== 'active') {
    throw integrationError(403, 'ENTERPRISE_DISABLED', '企业已停用');
  }

  const owner = tenant.owner_user_id
    ? queryOne(`SELECT id,phone,name,role,status,tenant_id,session_version
      FROM users WHERE id = ? AND role = '主管' AND status = 'active' AND tenant_id = ?`,
    [tenant.owner_user_id, tenant.id])
    : null;
  const supervisor = owner || queryOne(`SELECT id,phone,name,role,status,tenant_id,session_version
    FROM users WHERE role = '主管' AND status = 'active' AND tenant_id = ? ORDER BY id LIMIT 1`, [tenant.id]);
  if (!supervisor) throw integrationError(409, 'ENTERPRISE_SUPERVISOR_UNAVAILABLE', '企业暂无可用主管');
  return { tenant, supervisor };
}

function requireIntegrationToken(req, res, next) {
  const configured = String(config.JZMM_INGEST_TOKEN || '').trim();
  const supplied = req.headers['x-jzm-ingest-token'] || req.headers['x-integration-token'];
  if (!configured || !timingSafeTokenMatch(supplied, configured)) {
    return res.status(401).json({ error: '外部接入令牌无效', code: 'INVALID_INTEGRATION_TOKEN' });
  }
  try {
    const resolved = resolveEnterprise(enterpriseNameFrom(req.body));
    req.externalIntegration = true;
    req.integrationTenant = resolved.tenant;
    req.user = {
      id: resolved.supervisor.id,
      phone: resolved.supervisor.phone,
      name: resolved.supervisor.name,
      role: resolved.supervisor.role,
      status: resolved.supervisor.status,
      tenant_id: resolved.tenant.id,
      session_version: Number(resolved.supervisor.session_version || 0),
      tenant_status: resolved.tenant.status,
    };
    return next();
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || '企业归属解析失败',
      code: error.code || 'ENTERPRISE_RESOLUTION_FAILED',
    });
  }
}

module.exports = {
  enterpriseNameFrom,
  alertConfigFromBody,
  resolveEnterprise,
  requireIntegrationToken,
};
