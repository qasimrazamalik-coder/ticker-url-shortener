const config = require('./config');
const { createApp } = require('./app');
const { pool, query } = require('./db');
const clicks = require('./modules/clicks/buffer');
const { forgetOldSalts } = require('./modules/redirect/visitor');

const server = createApp().listen(config.port, () => {
  console.log(`Ticker running at ${config.publicBaseUrl}  (API docs: /api/docs)`);
});

clicks.start();

// Hourly housekeeping: drop old visitor salts and idle rate-limit buckets.
async function housekeeping() {
  const salts = await forgetOldSalts();
  const { rowCount: buckets } = await query(`DELETE FROM rate_buckets WHERE updated_at < now() - interval '1 day'`);
  if (salts || buckets) console.log(`Housekeeping: ${salts} old salt(s), ${buckets} idle bucket(s) removed`);
}
const hourly = setInterval(() => housekeeping().catch(console.error), 3600 * 1000);
housekeeping().catch(console.error);

// On shutdown, stop accepting requests, then write the clicks still in memory.
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(hourly);
  server.close(async () => {
    try { await clicks.stop(); } catch (err) { console.error('Final click flush failed:', err.message); }
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
