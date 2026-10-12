/**
 * Token-bucket rate limiting stored in PostgreSQL, so every server instance
 * shares the same buckets (an in-memory limiter would give each instance its
 * own allowance).
 *
 * A bucket holds up to `capacity` tokens and refills continuously at
 * `perSecond`. Each request takes one token. The whole check-refill-take
 * step is ONE statement:
 *
 *   INSERT ... ON CONFLICT (key) DO UPDATE SET tokens = refilled - 1
 *   WHERE refilled >= 1 RETURNING tokens
 *
 * ON CONFLICT DO UPDATE locks the bucket row and always works on its latest
 * committed version, so concurrent requests queue on the row and each sees
 * the tokens the previous one left. No row returned means the WHERE failed:
 * the bucket was empty and the request is refused. There is no window in
 * which two requests both read "1 token left".
 */
const { query } = require('../db');
const { AppError } = require('../errors');

const REFILLED = `least($2::float8, b.tokens + extract(epoch FROM clock_timestamp() - b.updated_at)::float8 * $3::float8)`;

async function take(key, capacity, perSecond) {
  const { rows } = await query(
    `INSERT INTO rate_buckets AS b (key, tokens, updated_at) VALUES ($1, $2::float8 - 1, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET tokens = ${REFILLED} - 1, updated_at = clock_timestamp()
      WHERE ${REFILLED} >= 1
     RETURNING tokens`, [key, capacity, perSecond]);
  if (rows.length) return { allowed: true, remaining: Math.floor(rows[0].tokens) };

  const { rows: [b] } = await query(
    `SELECT ${REFILLED} AS tokens FROM rate_buckets b WHERE key = $1`, [key, capacity, perSecond]);
  const missing = 1 - (b ? b.tokens : 0);
  return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil(missing / perSecond)) };
}

/**
 * Express middleware. `perMinute` tokens per minute, bursts up to `capacity`.
 * keyFn picks whose bucket a request draws from (an account, an IP ...).
 */
function rateLimit({ name, capacity, perMinute = capacity, keyFn }) {
  const perSecond = perMinute / 60;
  return async (req, res, next) => {
    const r = await take(`${name}:${keyFn(req)}`, capacity, perSecond);
    res.set('RateLimit-Limit', String(capacity));
    res.set('RateLimit-Remaining', String(r.remaining));
    if (r.allowed) return next();
    res.set('Retry-After', String(r.retryAfter));
    next(new AppError(429, 'RATE_LIMITED', `Slow down a little. Try again in ${r.retryAfter} seconds.`,
      { retryAfterSeconds: r.retryAfter }));
  };
}

module.exports = { rateLimit, take };
