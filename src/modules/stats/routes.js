/**
 * Analytics. Two sources, chosen per question:
 *
 *  - Raw `clicks` for one link: any time zone, unique visitors, referrers,
 *    devices, hour of day. Indexed on (link_id, at), so a link's range is a
 *    narrow index scan.
 *  - The `link_daily` rollup for the account overview, which spans every link
 *    and would otherwise scan every click the account ever got.
 *
 * Series are zero-filled with generate_series, so a chart gets one point per
 * day even on days nobody clicked.
 */
const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const { badRequest } = require('../../errors');
const { ownedLink, toLink } = require('../links/service');

const router = express.Router();

// Time zone names are checked by PostgreSQL itself (and remembered). Asking it
// to convert is instant; the pg_timezone_names view takes seconds to scan.
const knownZones = new Set(['UTC']);
async function checkZone(tz) {
  if (knownZones.has(tz)) return tz;
  try {
    await query('SELECT now() AT TIME ZONE $1', [tz]);
  } catch (err) {
    if (err.code === '22023') throw badRequest('INVALID_TIMEZONE', `Unknown time zone "${tz}". Use a name like Asia/Karachi.`);
    throw err;
  }
  knownZones.add(tz);
  return tz;
}

const range = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  tz: z.string().max(64).default('UTC'),
});

router.get('/links/:id/stats', authenticate, validate({ params: z.object({ id: z.coerce.number().int().positive() }), query: range }), async (req, res) => {
  const link = await ownedLink({ query }, req.user, req.valid.params.id);
  const { days } = req.valid.query;
  const tz = await checkZone(req.valid.query.tz);

  // $1 link, $2 tz, $3 days. `since` is local midnight, `days - 1` days ago, in tz.
  const SINCE = `(((now() AT TIME ZONE $2)::date - ($3::int - 1)) AT TIME ZONE $2)`;
  const HUMANS = `FROM clicks WHERE link_id = $1 AND device <> 'bot' AND at >= ${SINCE}`;
  const p = [link.id, tz, days];

  const [series, referrers, devices, browsers, hours, bots] = await Promise.all([
    query(`WITH d AS (
             SELECT generate_series((now() AT TIME ZONE $2)::date - ($3::int - 1), (now() AT TIME ZONE $2)::date, interval '1 day')::date AS day),
           c AS (
             SELECT (at AT TIME ZONE $2)::date AS day, count(*)::int AS clicks, count(DISTINCT visitor)::int AS visitors
             ${HUMANS} GROUP BY 1)
           SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.clicks, 0) AS clicks, coalesce(c.visitors, 0) AS visitors
             FROM d LEFT JOIN c USING (day) ORDER BY d.day`, p),
    query(`SELECT coalesce(referrer_host, 'direct') AS name, count(*)::int AS clicks ${HUMANS}
            GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, p),
    query(`SELECT device AS name, count(*)::int AS clicks ${HUMANS} GROUP BY 1 ORDER BY 2 DESC`, p),
    query(`SELECT browser AS name, count(*)::int AS clicks ${HUMANS} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, p),
    query(`SELECT h AS hour, coalesce(c.clicks, 0) AS clicks
             FROM generate_series(0, 23) AS h
             LEFT JOIN (SELECT extract(hour FROM at AT TIME ZONE $2)::int AS hour, count(*)::int AS clicks ${HUMANS} GROUP BY 1) c ON c.hour = h
            ORDER BY h`, p),
    query(`SELECT count(*)::int AS n FROM clicks WHERE link_id = $1 AND device = 'bot' AND at >= ${SINCE}`, p),
  ]);

  const s = series.rows;
  res.json({
    link: toLink(link),
    range: { days, tz, from: s[0].day, to: s[s.length - 1].day },
    totals: {
      clicks: s.reduce((n, d) => n + d.clicks, 0),
      // Visitors are only recognisable within a day (see visitor.js), so this
      // is the sum of each day's unique visitors.
      visitors: s.reduce((n, d) => n + d.visitors, 0),
      botsIgnored: bots.rows[0].n,
      allTime: Number(link.click_count),
    },
    series: s,
    referrers: referrers.rows,
    devices: devices.rows,
    browsers: browsers.rows,
    hours: hours.rows,
  });
});

router.get('/stats/overview', authenticate, async (req, res) => {
  const [totals, series, top] = await Promise.all([
    query(`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS links,
                  coalesce(sum(click_count), 0)::bigint AS "allTime"
             FROM links WHERE owner_id = $1`, [req.user.id]),
    query(`SELECT to_char(g.day, 'YYYY-MM-DD') AS day, coalesce(sum(d.clicks), 0)::int AS clicks
             FROM generate_series((now() AT TIME ZONE 'UTC')::date - 29, (now() AT TIME ZONE 'UTC')::date, interval '1 day') AS g(day)
             LEFT JOIN link_daily d ON d.day = g.day::date AND d.link_id IN (SELECT id FROM links WHERE owner_id = $1)
            GROUP BY g.day ORDER BY g.day`, [req.user.id]),
    query(`SELECT l.id, l.code, l.title, l.target_url AS target, sum(d.clicks)::int AS clicks
             FROM link_daily d JOIN links l ON l.id = d.link_id
            WHERE l.owner_id = $1 AND l.deleted_at IS NULL AND d.day > (now() AT TIME ZONE 'UTC')::date - 7
            GROUP BY l.id ORDER BY clicks DESC, l.id DESC LIMIT 5`, [req.user.id]),
  ]);
  const s = series.rows;
  res.json({
    links: totals.rows[0].links,
    allTime: Number(totals.rows[0].allTime),
    today: s[s.length - 1].clicks,
    last7: s.slice(-7).reduce((n, d) => n + d.clicks, 0),
    series: s,
    topLinks: top.rows,
  });
});

module.exports = { router };
