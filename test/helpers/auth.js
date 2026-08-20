const jwt = require('jsonwebtoken');
const config = require('../../config');

function authHeader(user) {
  const token = jwt.sign({ id: user.id, session_version: Number(user.session_version || 0) }, config.JWT_SECRET, { expiresIn: '5m' });
  return { Authorization: `Bearer ${token}` };
}

module.exports = { authHeader };
