const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeLink, visit, query, close, clicks, IPHONE } = require('./helpers');

beforeEach(reset);
after(close);

/** Inserts click rows at exact times, as the buffer would have. */
async function addClicks(linkId, list) {
  for (const c of list) {
    await query(`INSERT INTO clicks (link_id, at, visitor, referrer_host, device, browser) VALUES ($1, $2, $3, $4, $5, $6)`,
      [linkId, c.at, c.visitor || 'v1', c.ref || null, c.device || 'desktop', c.browser || 'Chrome']);
  }
}

const daysAgo = (n, hourUtc = 12) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};
const isoDay = (d) => d.toISOString().slice(0, 10);

describe('link stats', () => {
  test('the series has one point per day, zeros included, and visitors are counted per day', async () => {
    const u = await makeUser();
    const l = await makeLink(u);
    await addClicks(l.id, [
      { at: daysAgo(2), visitor: 'aaa' }, { at: daysAgo(2), visitor: 'aaa' }, { at: daysAgo(2), visitor: 'bbb' },
      { at: daysAgo(0, 0), visitor: 'aaa' },
      { at: daysAgo(1), device: 'bot', browser: 'Bot' },
      { at: daysAgo(20) },   // outside a 7-day range
    ]);
    const r = await api().get(`/api/links/${l.id}/stats?days=7`).set(u.auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.series.length, 7);
    assert.equal(r.body.series[6].day, isoDay(new Date()));
    const byDay = Object.fromEntries(r.body.series.map((d) => [d.day, d]));
    assert.deepEqual(byDay[isoDay(daysAgo(2))], { day: isoDay(daysAgo(2)), clicks: 3, visitors: 2 });
    assert.equal(byDay[isoDay(daysAgo(1))].clicks, 0, 'bots are left out');
    assert.equal(r.body.totals.clicks, 4);
    assert.equal(r.body.totals.visitors, 3);
    assert.equal(r.body.totals.botsIgnored, 1);
  });

  test('days and hours follow the time zone you ask for', async () => {
    const u = await makeUser();
    const l = await makeLink(u);
    const at = daysAgo(2, 21);   // 21:00 UTC is 02:00 the next day in Karachi (UTC+5)
    await addClicks(l.id, [{ at }]);

    const utc = await api().get(`/api/links/${l.id}/stats?days=7&tz=UTC`).set(u.auth);
    const pk = await api().get(`/api/links/${l.id}/stats?days=7&tz=Asia/Karachi`).set(u.auth);
    const dayWith = (res) => res.body.series.find((d) => d.clicks === 1).day;
    assert.equal(dayWith(utc), isoDay(at));
    assert.equal(dayWith(pk), isoDay(new Date(at.getTime() + 5 * 3600000)));
    assert.equal(utc.body.hours.find((h) => h.clicks === 1).hour, 21);
    assert.equal(pk.body.hours.find((h) => h.clicks === 1).hour, 2);
    assert.equal(pk.body.hours.length, 24);

    const bad = await api().get(`/api/links/${l.id}/stats?tz=Mars/Olympus`).set(u.auth);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_TIMEZONE');
  });

  test('referrers, devices and browsers come from real visits', async () => {
    const u = await makeUser();
    const l = await makeLink(u);
    await visit(l.code, { referer: 'https://news.ycombinator.com/item?id=1' });
    await visit(l.code, { referer: 'https://news.ycombinator.com/' , ip: '203.0.113.2' });
    await visit(l.code, { ua: IPHONE, ip: '203.0.113.3' });
    await clicks.flush();
    const r = await api().get(`/api/links/${l.id}/stats?days=1`).set(u.auth);
    assert.deepEqual(r.body.referrers, [{ name: 'news.ycombinator.com', clicks: 2 }, { name: 'direct', clicks: 1 }]);
    assert.deepEqual(r.body.devices, [{ name: 'desktop', clicks: 2 }, { name: 'mobile', clicks: 1 }]);
    assert.deepEqual(r.body.browsers.map((b) => b.name).sort(), ['Chrome', 'Safari']);
    assert.equal(r.body.totals.allTime, 3);
  });

  test('stats need an account', async () => {
    assert.equal((await api().get('/api/links/1/stats')).status, 401);
    assert.equal((await api().get('/api/stats/overview')).status, 401);
  });
});

describe('account overview', () => {
  test('adds up every link from the daily rollup', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const a = await makeLink(u, { title: 'A' });
    const b = await makeLink(u, { title: 'B' });
    const theirs = await makeLink(other);
    for (let i = 0; i < 4; i++) await visit(a.code, { ip: `192.0.2.${i}` });
    await visit(b.code);
    await visit(theirs.code);
    await clicks.flush();

    const r = await api().get('/api/stats/overview').set(u.auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.links, 2);
    assert.equal(r.body.today, 5);
    assert.equal(r.body.last7, 5);
    assert.equal(r.body.allTime, 5);
    assert.equal(r.body.series.length, 30);
    assert.deepEqual(r.body.topLinks.map((t) => [t.title, t.clicks]), [['A', 4], ['B', 1]]);
  });
});
