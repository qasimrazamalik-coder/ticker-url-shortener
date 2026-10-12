/**
 * Short codes.
 *
 * The obvious scheme, base62 of the row id, hands out 1, 2, 3 ... so anyone
 * can walk through every link ever made and see how busy the service is.
 * Random codes avoid that but need a collision check and retry on every insert.
 *
 * Ticker does neither. It passes the id through a keyed permutation first:
 * a bijection on [0, 62^7), so two ids can never produce the same code and no
 * collision check is needed, yet consecutive ids give unrelated-looking codes.
 *
 * The permutation is a 4-round Feistel network over 42 bits (2^42 is just above
 * 62^7) with "cycle walking": if the output lands at or above 62^7, permute
 * again until it does not. Because the network is a bijection on 42 bits, the
 * walk always ends and the result is still a bijection on [0, 62^7).
 *
 * This hides ordering; it is not encryption. Anyone holding a short link can
 * open it, so private links should use an expiry, a click limit, or be disabled.
 */
const crypto = require('crypto');
const config = require('../../config');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LENGTH = 7;
const SPACE = 62 ** LENGTH;          // 3,521,614,606,208 codes
const HALF_BITS = 21;
const HALF = 2 ** HALF_BITS;         // each Feistel half is 21 bits
const ROUNDS = 4;

function round(value, i, key) {
  const h = crypto.createHmac('sha256', key).update(`${i}:${value}`).digest();
  return h.readUIntBE(0, 3) % HALF;  // 24 bits reduced to 21
}

function feistel(x, key) {
  let left = Math.floor(x / HALF);
  let right = x % HALF;
  for (let i = 0; i < ROUNDS; i++) [left, right] = [right, (left ^ round(right, i, key)) >>> 0];
  return left * HALF + right;
}

function feistelInverse(y, key) {
  let left = Math.floor(y / HALF);
  let right = y % HALF;
  for (let i = ROUNDS - 1; i >= 0; i--) [left, right] = [(right ^ round(left, i, key)) >>> 0, left];
  return left * HALF + right;
}

/** Keyed bijection on [0, SPACE). */
function permute(x, key = config.codeSecret) {
  if (!Number.isSafeInteger(x) || x < 0 || x >= SPACE) throw new RangeError(`out of range: ${x}`);
  let y = feistel(x, key);
  while (y >= SPACE) y = feistel(y, key);
  return y;
}

function unpermute(y, key = config.codeSecret) {
  let x = feistelInverse(y, key);
  while (x >= SPACE) x = feistelInverse(x, key);
  return x;
}

function toBase62(n, width = LENGTH) {
  let s = '';
  do { s = ALPHABET[n % 62] + s; n = Math.floor(n / 62); } while (n > 0);
  return s.padStart(width, ALPHABET[0]);
}

function fromBase62(s) {
  let n = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new RangeError(`not base62: ${ch}`);
    n = n * 62 + v;
  }
  return n;
}

/** The code a link with this id gets. Always 7 characters. */
const codeForId = (id, key) => toBase62(permute(id, key));

/** Inverse of codeForId; used by tests and handy when debugging. */
const idForCode = (code, key) => unpermute(fromBase62(code), key);

// Paths the app itself uses. Custom aliases cannot take them.
const RESERVED = new Set(['api', 'app', 'docs', 'admin', 'login', 'logout', 'signin', 'signup', 'register',
  'static', 'assets', 'public', 'health', 'favicon', 'robots', 'index', 'help', 'about', 'stats', 'settings']);

module.exports = { codeForId, idForCode, permute, unpermute, toBase62, fromBase62, RESERVED, SPACE, LENGTH };
