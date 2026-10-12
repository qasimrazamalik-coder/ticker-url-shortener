const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { pool, query } = require('../src/db');
const { signToken } = require('../src/middleware/auth');
const { linkCache } = require('../src/modules/links/cache');
const clicks = require('../src/modules/clicks/buffer');
const { resetSaltCache } = require('../src/modules/redirect/visitor');

const app = createApp();
const api = () => request(app);

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WHATSAPP = 'WhatsApp/2.23.20.0 A';

let seq = 0;
const HASH = bcrypt.hashSync('password123', 4);

async function reset() {
  await clicks.flush();
  await query('TRUNCATE clicks, link_daily, links, visitor_salts, rate_buckets, users RESTART IDENTITY CASCADE');
  linkCache.clear();
  resetSaltCache();
}

async function makeUser() {
  seq += 1;
  const { rows: [u] } = await query(
    'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *', [`User ${seq}`, `user${seq}@test.local`, HASH]);
  return { ...u, auth: { Authorization: `Bearer ${signToken(u)}` } };
}

async function makeLink(user, body = {}) {
  const res = await api().post('/api/links').set(user.auth).send({ url: 'https://example.com/page', ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body;
}

/** One click as a browser at a given IP would make it. */
const visit = (code, { ip = '203.0.113.7', ua = CHROME, referer } = {}) => {
  const r = api().get(`/${code}`).set('User-Agent', ua).set('X-Forwarded-For', ip);
  return referer ? r.set('Referer', referer) : r;
};

const close = () => pool.end();

module.exports = { api, reset, makeUser, makeLink, visit, query, close, clicks, linkCache, CHROME, IPHONE, WHATSAPP };
