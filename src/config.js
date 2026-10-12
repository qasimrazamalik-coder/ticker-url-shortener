// Central configuration from environment variables, with development defaults.
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env.NODE_ENV || 'development';
const port = Number(process.env.PORT || 3004);

const config = {
  env,
  port,
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5544/ticker',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  // The address short links are shown with, e.g. https://tkr.example
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  // Key for the code permutation. Changing it changes which codes new links get
  // (existing links keep theirs, the code is stored).
  codeSecret: process.env.CODE_SECRET || 'dev-only-code-secret',
  // Behind a proxy or load balancer, set to 1 so the client IP comes from X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === '1' ? 1 : false,
  // Link creation: a burst of N, refilled at N per minute, per account.
  linkRateBurst: Number(process.env.LINK_RATE_BURST || 30),
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS || 60),
  cacheMaxEntries: Number(process.env.CACHE_MAX_ENTRIES || 10000),
  flushMs: Number(process.env.CLICK_FLUSH_MS || 1000),
};

if (env === 'production' && (config.jwtSecret === 'dev-only-secret-change-me' || config.codeSecret === 'dev-only-code-secret')) {
  throw new Error('JWT_SECRET and CODE_SECRET must be set in production');
}

module.exports = config;
