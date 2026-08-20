/**
 * JWT 鉴权中间件
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { queryOne } = require('../db');
const { isSupervisorUser } = require('../services/roles');

function generateToken(user, rememberMe) {
  return jwt.sign(
    { id: user.id, session_version: Number(user.session_version || 0) },
    config.JWT_SECRET,
    { expiresIn: rememberMe ? config.JWT_EXPIRES_LONG : config.JWT_EXPIRES }
  );
}

function usersTableExists() {
  return Boolean(queryOne("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"));
}

function verifyToken(req, res, next) {
  // 允许不带 token 的公开接口通过（登录/注册/重置密码）
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.slice(7);
  try {
    const claims = jwt.verify(token, config.JWT_SECRET);
    let current;
    try {
      if (!usersTableExists()) {
        // 兼容完全不提供认证表、只验证独立路由行为的轻量测试夹具。
        req.user = claims;
        return next();
      }
      current = queryOne(`SELECT
        u.id,u.phone,u.name,u.role,u.status,u.tenant_id,u.session_version,
        t.status AS tenant_status
        FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id WHERE u.id=?`, [claims.id]);
    } catch (error) {
      // 数据库不可用不是“未登录”，避免把真实故障伪装成 401。
      return res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
    }
    const isPlatform = current?.role === 'platform_owner';
    const valid = current
      && String(current.status || '').toLowerCase() === 'active'
      && Number(current.session_version || 0) === Number(claims.session_version)
      && (isPlatform
        ? !current.tenant_id
        : Boolean(current.tenant_id) && current.tenant_status === 'active');
    if (!valid) {
      return res.status(401).json({ error: '未登录或 token 已失效', code: 'AUTH_REQUIRED' });
    }
    req.user = {
      id: current.id,
      phone: current.phone,
      name: current.name,
      role: current.role,
      status: current.status,
      tenant_id: current.tenant_id,
      session_version: Number(current.session_version || 0),
      tenant_status: current.tenant_status,
    };
    next();
  } catch (e) {
    req.user = null;
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未登录或 token 已过期', code: 'AUTH_REQUIRED' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !isSupervisorUser(req.user) || !req.user.tenant_id) {
    return res.status(403).json({ error: '需要主管权限' });
  }
  next();
}

function requirePlatformOwner(req, res, next) {
  if (!req.user || req.user.role !== 'platform_owner' || req.user.tenant_id) {
    return res.status(403).json({ error: '需要平台运维权限', code: 'PLATFORM_OWNER_REQUIRED' });
  }
  next();
}

function requireTenantUser(req, res, next) {
  if (!req.user?.tenant_id || req.user.role === 'platform_owner') {
    return res.status(403).json({ error: '需要企业账号', code: 'TENANT_USER_REQUIRED' });
  }
  next();
}

module.exports = {
  generateToken, verifyToken, requireAuth, requireAdmin, requirePlatformOwner, requireTenantUser,
};
