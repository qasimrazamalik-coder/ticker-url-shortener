const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized } = require('../errors');

function signToken(user) {
  return jwt.sign({ sub: String(user.id), name: user.name }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

function authenticate(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    const p = jwt.verify(token, config.jwtSecret);
    req.user = { id: Number(p.sub), name: p.name };
    next();
  } catch {
    next(unauthorized('Your session has expired. Sign in again.'));
  }
}

module.exports = { signToken, authenticate };
