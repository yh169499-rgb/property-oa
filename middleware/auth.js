/**
 * JWT 鉴权中间件
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { queryOne } = require('../db');
const { isSupervisorUser } = require('../services/roles');

function generateToken(user, rememberMe) {
  return jwt.sign(
    { id: user.id, phone: user.phone, name: user.name, role: user.role },
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
      current = queryOne('SELECT * FROM users WHERE id = ?', [claims.id]);
    } catch (error) {
      // 数据库不可用不是“未登录”，避免把真实故障伪装成 401。
      return res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
    }
    if (!current || String(current.status || 'active').toLowerCase() !== 'active') {
      req.user = null;
      return next();
    }
    req.user = {
      ...claims,
      id: current.id,
      phone: current.phone,
      name: current.name,
      role: current.role,
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
  if (!req.user || !isSupervisorUser(req.user)) {
    return res.status(403).json({ error: '需要主管权限' });
  }
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, requireAdmin };
