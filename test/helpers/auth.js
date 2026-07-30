const jwt = require('jsonwebtoken');
const config = require('../../config');

function authHeader(user) {
  const token = jwt.sign(user, config.JWT_SECRET, { expiresIn: '5m' });
  return { Authorization: `Bearer ${token}` };
}

module.exports = { authHeader };
