const config = require('../../config');
const { query, transaction } = require('../../db');
const { badRequest, notFound, conflict } = require('../../errors');
const { codeForId, RESERVED } = require('./codes');
const { normalizeTarget } = require('./urls');
const { linkCache } = require('./cache');

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;

function statusOf(l) {
  if (l.deleted_at) return 'deleted';
  if (l.disabled_at) return 'disabled';
  if (l.expires_at && new Date(l.expires_at) <= new Date()) return 'expired';
  if (l.max_clicks != null && Number(l.click_count) >= l.max_clicks) return 'used_up';
  return 'active';
}

const toLink = (l) => ({
  id: l.id,
  code: l.code,
  shortUrl: `${config.publicBaseUrl}/${l.code}`,
  target: l.target_url,
  title: l.title,
  custom: l.custom,
  expiresAt: l.expires_at,
  maxClicks: l.max_clicks,
  clicks: Number(l.click_count),
  status: statusOf(l),
  createdAt: l.created_at,
  updatedAt: l.updated_at,
  ...(l.last14 ? { last14: l.last14 } : {}),
});

function checkAlias(alias) {
  if (!ALIAS.test(alias)) {
    throw badRequest('INVALID_ALIAS', 'Short names use 3 to 32 letters, digits, - or _, and start with a letter or digit.');
  }
  if (RESERVED.has(alias.toLowerCase())) throw conflict('ALIAS_RESERVED', `"${alias}" is used by Ticker itself. Pick another.`);
}

function checkLimits({ expiresAt, maxClicks }) {
  if (expiresAt && new Date(expiresAt) <= new Date()) throw badRequest('EXPIRY_IN_PAST', 'The expiry time has to be in the future.');
  if (maxClicks != null && (!Number.isInteger(maxClicks) || maxClicks < 1)) throw badRequest('INVALID_LIMIT', 'A click limit must be at least 1.');
}

/**
 * Generated codes: take the next id from the sequence, derive the code from it
 * (codes.js), insert with that id. Codes from different ids never collide, so
 * the only possible clash is with a custom alias someone already chose that
 * happens to equal a generated code; then the id is skipped and we try the next.
 */
async function createLink(user, { url, alias, title = '', expiresAt = null, maxClicks = null }) {
  const target = normalizeTarget(url);
  checkLimits({ expiresAt, maxClicks });

  let row;
  if (alias) {
    checkAlias(alias);
    // Two people claiming the same alias at once: the UNIQUE constraint on code
    // lets exactly one insert succeed; the other gets 23505 -> 409 ALIAS_TAKEN.
    ({ rows: [row] } = await query(
      `INSERT INTO links (owner_id, code, custom, target_url, title, expires_at, max_clicks)
       VALUES ($1, $2, true, $3, $4, $5, $6) RETURNING *`,
      [user.id, alias, target, title, expiresAt, maxClicks]));
  } else {
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      const { rows: [{ id }] } = await query(`SELECT nextval(pg_get_serial_sequence('links', 'id'))::bigint AS id`);
      try {
        ({ rows: [row] } = await query(
          `INSERT INTO links (id, owner_id, code, target_url, title, expires_at, max_clicks)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [id, user.id, codeForId(Number(id)), target, title, expiresAt, maxClicks]));
      } catch (err) {
        if (!(err.code === '23505' && err.constraint === 'links_code_key')) throw err;
      }
    }
    if (!row) throw new Error('could not allocate a short code');
  }
  // Someone may have tried this code before it existed; drop the cached "not found".
  linkCache.delete(row.code);
  return toLink(row);
}

async function ownedLink(db, user, id, { lock = false } = {}) {
  const { rows: [l] } = await db.query(
    `SELECT * FROM links WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id]);
  // Someone else's link is reported as missing, not forbidden: no probing which ids exist.
  if (!l || l.owner_id !== user.id) throw notFound('Link');
  return l;
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Newest first, keyset-paginated on id, each with its last 14 days of clicks. */
async function listLinks(user, { q, cursor, limit }) {
  const params = [user.id, limit + 1];
  let where = 'l.owner_id = $1 AND l.deleted_at IS NULL';
  if (cursor) { params.push(cursor); where += ` AND l.id < $${params.length}`; }
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    where += ` AND (l.code ILIKE $${params.length} OR l.target_url ILIKE $${params.length} OR l.title ILIKE $${params.length})`;
  }
  const { rows } = await query(
    `SELECT l.*,
            (SELECT array_agg(coalesce(d.clicks, 0) ORDER BY g.day)
               FROM generate_series((now() AT TIME ZONE 'UTC')::date - 13, (now() AT TIME ZONE 'UTC')::date, interval '1 day') AS g(day)
               LEFT JOIN link_daily d ON d.link_id = l.id AND d.day = g.day::date) AS last14
       FROM links l WHERE ${where} ORDER BY l.id DESC LIMIT $2`, params);
  const page = rows.slice(0, limit);
  return { links: page.map(toLink), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

async function getLink(user, id) {
  return toLink(await ownedLink({ query }, user, id));
}

async function updateLink(user, id, changes) {
  const row = await transaction(async (c) => {
    const l = await ownedLink(c, user, id, { lock: true });
    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (changes.url !== undefined) set('target_url', normalizeTarget(changes.url));
    if (changes.title !== undefined) set('title', changes.title);
    if (changes.expiresAt !== undefined) {
      checkLimits({ expiresAt: changes.expiresAt });
      set('expires_at', changes.expiresAt);
    }
    if (changes.maxClicks !== undefined) {
      checkLimits({ maxClicks: changes.maxClicks });
      if (changes.maxClicks !== null && changes.maxClicks < Number(l.click_count)) {
        throw conflict('BELOW_CLICK_COUNT', `This link already has ${l.click_count} clicks; the limit cannot be lower than that.`);
      }
      set('max_clicks', changes.maxClicks);
    }
    if (changes.disabled !== undefined) set('disabled_at', changes.disabled ? (l.disabled_at || new Date()) : null);
    if (!sets.length) return l;

    params.push(l.id);
    const { rows: [updated] } = await c.query(`UPDATE links SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    return updated;
  });
  // After commit, so a redirect cannot re-cache the old row in between.
  linkCache.delete(row.code);
  return toLink(row);
}

async function deleteLink(user, id) {
  const code = await transaction(async (c) => {
    const l = await ownedLink(c, user, id, { lock: true });
    await c.query('UPDATE links SET deleted_at = now() WHERE id = $1', [l.id]);
    return l.code;
  });
  linkCache.delete(code);
}

module.exports = { createLink, listLinks, getLink, updateLink, deleteLink, ownedLink, toLink, statusOf };
