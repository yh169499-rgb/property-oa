/**
 * JWT 鉴权中间件
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { isManagerRole } = require('../services/roles');

function generateToken(user, rememberMe) {
  return jwt.sign(
    { id: user.id, phone: user.phone, name: user.name, role: user.role },
    config.JWT_SECRET,
    { expiresIn: rememberMe ? config.JWT_EXPIRES_LONG : config.JWT_EXPIRES }
  );
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
    req.user = jwt.verify(token, config.JWT_SECRET);
    next();
  } catch (e) {
    req.user = null;
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未登录或 token 已过期' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !isManagerRole(req.user.role)) {
    return res.status(403).json({ error: '需要主管权限' });
  }
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, requireAdmin };
