/**
 * Click buffer: the redirect path drops a click here and returns at once.
 * Every second (or sooner, once 500 clicks are waiting) the buffer is written
 * in ONE transaction of three set-based statements, however many clicks it holds:
 *
 *   1. INSERT ... SELECT FROM unnest(arrays)   raw click rows
 *   2. INSERT ... ON CONFLICT DO UPDATE        daily rollup, humans only
 *   3. UPDATE links ... FROM unnest(arrays)    click_count for uncapped links
 *
 * The trade-off is stated plainly: if the process crashes, up to one second of
 * clicks is lost from the analytics. Redirects themselves never wait on an
 * analytics write. Capped links are not exposed to this: their counter is
 * updated synchronously in the redirect, and `counted` marks those clicks so
 * step 3 skips them.
 */
const { transaction } = require('../../db');
const config = require('../../config');

const MAX_QUEUE = 50000;   // bound memory if the database is down for a while
const BATCH_TRIGGER = 500;

const queue = [];
let inFlight = null;
let timer = null;
let consecutiveFailures = 0;
const stats = { written: 0, dropped: 0 };

function record(click) {
  queue.push(click);
  if (queue.length > MAX_QUEUE) stats.dropped += queue.splice(0, queue.length - MAX_QUEUE).length;
  if (queue.length >= BATCH_TRIGGER && !inFlight) flush().catch(() => {});
}

const utcDay = (d) => d.toISOString().slice(0, 10);

async function write(batch) {
  await transaction(async (c) => {
    await c.query(
      `INSERT INTO clicks (link_id, at, visitor, referrer_host, device, browser)
       SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[])`,
      [batch.map((k) => k.linkId), batch.map((k) => k.at), batch.map((k) => k.visitor),
        batch.map((k) => k.referrerHost), batch.map((k) => k.device), batch.map((k) => k.browser)]);

    const humans = batch.filter((k) => k.device !== 'bot');

    const daily = new Map();
    for (const k of humans) {
      const key = `${k.linkId}|${utcDay(k.at)}`;
      daily.set(key, (daily.get(key) || 0) + 1);
    }
    // Sorted, so two instances flushing at once take row locks in the same order.
    const rows = [...daily].map(([key, n]) => [...key.split('|'), n]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    if (rows.length) {
      await c.query(
        `INSERT INTO link_daily (link_id, day, clicks)
         SELECT * FROM unnest($1::bigint[], $2::date[], $3::int[])
         ON CONFLICT (link_id, day) DO UPDATE SET clicks = link_daily.clicks + excluded.clicks`,
        [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])]);
    }

    const pending = new Map();
    for (const k of humans) if (!k.counted) pending.set(k.linkId, (pending.get(k.linkId) || 0) + 1);
    if (pending.size) {
      const ids = [...pending.keys()].sort((a, b) => a - b);
      await c.query('SELECT id FROM links WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
      // least(): if a limit was added to the link while these clicks were
      // waiting, the counter stops at the limit instead of failing the batch.
      await c.query(
        `UPDATE links l SET click_count = CASE WHEN l.max_clicks IS NULL THEN l.click_count + v.n
                                               ELSE least(l.max_clicks, l.click_count + v.n) END
           FROM unnest($1::bigint[], $2::int[]) AS v(id, n) WHERE l.id = v.id`,
        [ids, ids.map((id) => pending.get(id))]);
    }
  });
}

/** Writes everything waiting. Safe to call at any time; concurrent calls queue up. */
async function flush() {
  while (inFlight) await inFlight.catch(() => {});
  if (!queue.length) return 0;
  const batch = queue.splice(0, queue.length);
  inFlight = write(batch);
  try {
    await inFlight;
    consecutiveFailures = 0;
    stats.written += batch.length;
    return batch.length;
  } catch (err) {
    consecutiveFailures += 1;
    // Put the clicks back for the next attempt, unless this batch keeps failing:
    // a batch that can never be written must not block every later click.
    if (consecutiveFailures < 5) queue.unshift(...batch);
    else { stats.dropped += batch.length; consecutiveFailures = 0; }
    throw err;
  } finally {
    inFlight = null;
  }
}

function start() {
  if (!timer) timer = setInterval(() => flush().catch((e) => console.error('click flush failed:', e.message)), config.flushMs);
}

async function stop() {
  clearInterval(timer);
  timer = null;
  await flush();
}

const pendingCount = () => queue.length;

module.exports = { record, flush, start, stop, pendingCount, stats };
