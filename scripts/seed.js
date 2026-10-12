// Demo data: two accounts and a handful of links with a month of clicks.
// Clicks are generated with a fixed random seed so every run looks the same.
const bcrypt = require('bcryptjs');
const { pool, transaction } = require('../src/db');
const { codeForId } = require('../src/modules/links/codes');

let state = 20251013;
const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (pairs) => {
  const total = pairs.reduce((n, [, w]) => n + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[pairs.length - 1][0];
};

const LINKS = [
  { title: 'Thesis draft, chapter 3', url: 'https://docs.example.edu/thesis/chapter-3', perDay: 6, refs: [['direct', 5], ['mail.google.com', 3], ['teams.microsoft.com', 2]] },
  { title: 'Spring workshop sign-up', url: 'https://forms.example.org/workshop-spring', alias: 'workshop', perDay: 14, spike: 9, refs: [['linkedin.com', 5], ['direct', 3], ['t.co', 3], ['facebook.com', 1]] },
  { title: 'Portfolio', url: 'https://qasim.example.dev/portfolio', perDay: 4, refs: [['github.com', 4], ['linkedin.com', 3], ['direct', 2]] },
  { title: 'Dataset download (5 uses)', url: 'https://data.example.org/files/survey-2026.zip', maxClicks: 5, perDay: 0 },
  { title: 'Reading list', url: 'https://notes.example.com/reading-list', perDay: 2, refs: [['direct', 3], ['news.ycombinator.com', 1]] },
];

(async () => {
  await transaction(async (c) => {
    await c.query('TRUNCATE clicks, link_daily, links, visitor_salts, rate_buckets, users RESTART IDENTITY CASCADE');
    const hash = await bcrypt.hash('password123', 10);
    const { rows: [demo] } = await c.query(
      `INSERT INTO users (name, email, password_hash) VALUES ('Qasim Malik', 'demo@ticker.test', $1) RETURNING id`, [hash]);
    await c.query(`INSERT INTO users (name, email, password_hash) VALUES ('Sana Iqbal', 'sana@ticker.test', $1)`, [hash]);

    for (const spec of LINKS) {
      const { rows: [{ id }] } = await c.query(`SELECT nextval(pg_get_serial_sequence('links', 'id'))::int AS id`);
      const code = spec.alias || codeForId(id);
      await c.query(
        `INSERT INTO links (id, owner_id, code, custom, target_url, title, max_clicks, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '30 days')`,
        [id, demo.id, code, Boolean(spec.alias), spec.url, spec.title, spec.maxClicks || null]);

      const rows = [];
      for (let back = 29; back >= 0; back--) {
        const weekday = new Date(Date.now() - back * 86400000).getUTCDay();
        let n = Math.round(spec.perDay * (weekday === 0 || weekday === 6 ? 0.5 : 1) * (0.5 + rand()));
        if (spec.spike && back === spec.spike) n *= 5;   // the day it was posted
        for (let i = 0; i < n; i++) {
          // Pakistan-time working hours, mostly: 09:00-23:00 PKT is 04:00-18:00 UTC.
          const hour = pick([[4, 1], [6, 2], [8, 3], [10, 3], [12, 2], [14, 3], [16, 2], [18, 1], [21, 1]]);
          const at = new Date(Date.now() - back * 86400000);
          at.setUTCHours(hour, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
          if (at > new Date()) continue;
          const device = pick([['mobile', 6], ['desktop', 4], ['tablet', 1]]);
          const browser = device === 'desktop' ? pick([['Chrome', 6], ['Edge', 2], ['Firefox', 1], ['Safari', 1]])
            : pick([['Chrome', 5], ['Safari', 4], ['Samsung Internet', 1]]);
          const ref = pick(spec.refs);
          rows.push([at, `v${Math.floor(rand() * n * 0.8)}-${back}`, ref === 'direct' ? null : ref, device, browser]);
        }
        // A few link-preview bots, which the stats leave out.
        if (n && rand() < 0.4) rows.push([new Date(Date.now() - back * 86400000), 'bot', null, 'bot', 'Bot']);
      }
      if (spec.maxClicks) {
        for (let i = 0; i < 3; i++) rows.push([new Date(Date.now() - (5 - i) * 86400000), `dl${i}`, 'mail.google.com', 'desktop', 'Chrome']);
      }
      if (!rows.length) continue;
      await c.query(
        `INSERT INTO clicks (link_id, at, visitor, referrer_host, device, browser)
         SELECT $1, * FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[])`,
        [id, ...[0, 1, 2, 3, 4].map((k) => rows.map((r) => r[k]))]);
    }

    // Rebuild the rollup and counters from the raw clicks, exactly as the buffer would have.
    await c.query(`INSERT INTO link_daily (link_id, day, clicks)
                   SELECT link_id, (at AT TIME ZONE 'UTC')::date, count(*) FROM clicks WHERE device <> 'bot' GROUP BY 1, 2`);
    await c.query(`UPDATE links l SET click_count = (SELECT count(*) FROM clicks k WHERE k.link_id = l.id AND k.device <> 'bot')`);
  });

  console.log('Seeded. Sign in with demo@ticker.test (or sana@ticker.test), password: password123');
  console.log('Try a short link: http://localhost:3004/workshop');
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
