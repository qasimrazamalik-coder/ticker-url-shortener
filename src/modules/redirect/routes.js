/**
 * GET /:code, the hot path.
 *
 *   1. Look the code up, normally from the in-memory LRU cache (no database).
 *   2. Refuse disabled, expired and unknown links with a small human page.
 *   3. Capped links only: count the click in the database, atomically:
 *        UPDATE links SET click_count = click_count + 1
 *         WHERE id = $1 AND click_count < max_clicks
 *      Row locking serialises concurrent clicks on the row, and each one
 *      re-checks the condition against the latest count, so with a limit of 5
 *      exactly five succeed however many arrive together. Zero rows updated
 *      means the link is used up.
 *   4. Hand the click to the buffer (no database write) and redirect.
 *
 * Bots and link previews are redirected but never use up a capped link: a
 * WhatsApp preview fetching a one-time link must not burn it.
 */
const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const { validate } = require('../../middleware/validate');
const { notFound } = require('../../errors');
const { linkCache } = require('../links/cache');
const { statusOf } = require('../links/service');
const { classify, referrerHost } = require('./agent');
const { visitorId } = require('./visitor');
const clicks = require('../clicks/buffer');

const CODE = /^[A-Za-z0-9_-]{3,32}$/;

async function lookup(code) {
  const hit = linkCache.get(code);
  if (hit) return hit.value;
  const { rows: [l] } = await query(
    'SELECT id, target_url, expires_at, max_clicks, disabled_at, deleted_at FROM links WHERE code = $1', [code]);
  const value = l && !l.deleted_at ? {
    id: l.id,
    target: l.target_url,
    expiresAt: l.expires_at ? l.expires_at.getTime() : null,
    capped: l.max_clicks != null,
    disabled: Boolean(l.disabled_at),
  } : null;
  linkCache.set(code, value);
  return value;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, status, heading, text) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)} | Ticker</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#E9EEF2;color:#12202B;font:17px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:2rem}h1{font-size:1.6rem;margin:0 0 .4rem}a{color:#D9480F}</style></head>
<body><main><h1>${esc(heading)}</h1><p>${esc(text)}</p><p><a href="/">Go to Ticker</a></p></main></body></html>`);
}

const router = express.Router();

/** Where does a short link go? Answers without counting a click. */
router.get('/api/peek/:code', validate({ params: z.object({ code: z.string().regex(CODE) }) }), async (req, res) => {
  const { rows: [l] } = await query('SELECT * FROM links WHERE code = $1 AND deleted_at IS NULL', [req.valid.params.code]);
  if (!l) throw notFound('Short link');
  res.json({ code: l.code, target: l.target_url, title: l.title, status: statusOf(l), createdAt: l.created_at });
});

router.get('/:code', async (req, res, next) => {
  const { code } = req.params;
  if (!CODE.test(code)) return next();

  const link = await lookup(code);
  if (!link) return page(res, 404, 'No such link', 'This short link does not exist, or it was deleted. Check it was copied in full.');
  if (link.disabled) return page(res, 410, 'Link switched off', 'Whoever made this link has switched it off.');
  if (link.expiresAt !== null && link.expiresAt <= Date.now()) return page(res, 410, 'Link expired', 'This link had an expiry date, and it has passed.');

  const ua = req.get('user-agent') || '';
  const agent = classify(ua);

  let counted = false;
  if (link.capped && agent.device !== 'bot') {
    const { rowCount } = await query(
      'UPDATE links SET click_count = click_count + 1 WHERE id = $1 AND click_count < max_clicks', [link.id]);
    if (!rowCount) return page(res, 410, 'Link used up', 'This link could only be opened a set number of times, and it has been.');
    counted = true;
  }

  const at = new Date();
  clicks.record({
    linkId: link.id, at, counted,
    visitor: await visitorId(req.ip, ua, at),
    referrerHost: referrerHost(req.get('referer')),
    device: agent.device,
    browser: agent.browser,
  });

  // 302, not 301: browsers cache 301s forever, so later clicks would never
  // reach us (no analytics) and an edited link would keep its old target.
  res.set('Cache-Control', 'private, no-store');
  res.redirect(302, link.target);
});

module.exports = { router, lookup };
