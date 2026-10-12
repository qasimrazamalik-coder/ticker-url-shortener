const { AppError } = require('../errors');

const constraintMessages = {
  users_email_uq: ['EMAIL_TAKEN', 'An account with that email already exists.'],
  links_code_key: ['ALIAS_TAKEN', 'That short name is already taken. Try another.'],
};

function notFoundRoute(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  err = toAppError(err);
  res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
}

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  if (err.code === '23505') {
    const [code, message] = constraintMessages[err.constraint] || ['DUPLICATE', 'That record already exists.'];
    return new AppError(409, code, message);
  }
  if (err.code === '23503') return new AppError(409, 'REFERENCED', 'That record is still referenced by other data.');
  if (err.code === '23514') return new AppError(400, 'CONSTRAINT_FAILED', 'A value is outside the allowed range.');
  if (err.code === '40P01') return new AppError(503, 'RETRY', 'The server was busy. Try again.');
  console.error(err);
  return new AppError(500, 'INTERNAL', 'Something went wrong on the server.');
}

module.exports = { errorHandler, notFoundRoute, toAppError };
