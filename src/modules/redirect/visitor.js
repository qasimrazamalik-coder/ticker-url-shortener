/**
 * Unique visitors without storing IP addresses or setting cookies.
 *
 * visitor = sha256(daily salt + IP + user agent), first 16 hex characters.
 *
 * The salt is random, one per UTC day, kept in the database so every server
 * instance agrees on it, and deleted once yesterday's is no longer needed. While the salt
 * exists the same person gets the same hash all day, so they are counted once.
 * After it is deleted the hashes cannot be reversed to an IP, even by us,
 * and the same person gets a different hash tomorrow, so visitors can only be
 * counted per day, never followed across days.
 */
const crypto = require('crypto');
const { query } = require('../../db');

let current = { day: null, salt: null };

async function saltFor(day) {
  if (current.day === day) return current.salt;
  // Two instances may race to create today's salt; ON CONFLICT keeps the first.
  await query('INSERT INTO visitor_salts (day, salt) VALUES ($1, $2) ON CONFLICT (day) DO NOTHING', [day, crypto.randomBytes(16)]);
  const { rows: [row] } = await query('SELECT salt FROM visitor_salts WHERE day = $1', [day]);
  current = { day, salt: row.salt };
  return row.salt;
}

async function visitorId(ip, userAgent, at = new Date()) {
  const salt = await saltFor(at.toISOString().slice(0, 10));
  return crypto.createHash('sha256').update(salt).update(`${ip}\n${userAgent}`).digest('hex').slice(0, 16);
}

/** Housekeeping: forget salts older than yesterday. */
async function forgetOldSalts() {
  const { rowCount } = await query(`DELETE FROM visitor_salts WHERE day < (now() AT TIME ZONE 'UTC')::date - 1`);
  return rowCount;
}

const resetSaltCache = () => { current = { day: null, salt: null }; };

module.exports = { visitorId, forgetOldSalts, resetSaltCache };
