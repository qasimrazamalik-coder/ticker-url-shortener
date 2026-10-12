const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeLink, visit, query, close, clicks, linkCache, IPHONE, WHATSAPP } = require('./helpers');

beforeEach(reset);
after(close);

const linkRow = async (id) => (await query('SELECT click_count FROM links WHERE id = $1', [id])).rows[0];

describe('redirecting', () => {
  test('a click redirects with 302 and no-store, and is written only when the buffer flushes', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { url: 'https://example.com/landing' });

    const r = await visit(l.code, { ua: IPHONE, referer: 'https://www.linkedin.com/feed/' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, 'https://example.com/landing');
    assert.match(r.headers['cache-control'], /no-store/);

    assert.equal((await query('SELECT count(*)::int AS n FROM clicks')).rows[0].n, 0, 'nothing written on the hot path');
    assert.equal(await clicks.flush(), 1);

    const { rows: [c] } = await query('SELECT * FROM clicks');
    assert.equal(c.referrer_host, 'linkedin.com');
    assert.equal(c.device, 'mobile');
    assert.equal(c.browser, 'Safari');
    assert.equal((await linkRow(l.id)).click_count, 1);
    assert.equal((await query('SELECT clicks FROM link_daily WHERE link_id = $1', [l.id])).rows[0].clicks, 1);
  });

  test('unknown, switched-off and expired links get a human page, not a redirect', async () => {
    const u = await makeUser();
    const missing = await visit('nope123');
    assert.equal(missing.status, 404);
    assert.match(missing.headers['content-type'], /html/);

    const off = await makeLink(u);
    await api().patch(`/api/links/${off.id}`).set(u.auth).send({ disabled: true });
    assert.equal((await visit(off.code)).status, 410);

    const old = await makeLink(u);
    await query(`UPDATE links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old.id]);
    linkCache.clear();
    const expired = await visit(old.code);
    assert.equal(expired.status, 410);
    assert.match(expired.text, /expired/i);

    await clicks.flush();
    assert.equal((await query('SELECT count(*)::int AS n FROM clicks')).rows[0].n, 0, 'refused visits are not clicks');
  });

  test('link previews are redirected but not counted', async () => {
    const u = await makeUser();
    const l = await makeLink(u);
    assert.equal((await visit(l.code, { ua: WHATSAPP })).status, 302);
    await visit(l.code);
    await clicks.flush();
    assert.equal((await linkRow(l.id)).click_count, 1);
    const { rows } = await query('SELECT device FROM clicks ORDER BY id');
    assert.deepEqual(rows.map((r) => r.device), ['bot', 'desktop'], 'the bot visit is kept, flagged');
  });

  test('RACE: a link limited to 5 clicks, 25 people click at once, exactly 5 get through', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { maxClicks: 5 });
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => visit(l.code, { ip: `198.51.100.${i}` })));
    assert.equal(results.filter((r) => r.status === 302).length, 5);
    assert.equal(results.filter((r) => r.status === 410).length, 20);
    assert.equal((await linkRow(l.id)).click_count, 5);
    await clicks.flush();
    assert.equal((await linkRow(l.id)).click_count, 5, 'the flush does not count them a second time');
    assert.equal((await query('SELECT count(*)::int AS n FROM clicks')).rows[0].n, 5);
  });

  test('a one-time link survives being previewed in a chat app', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { maxClicks: 1 });
    for (let i = 0; i < 3; i++) assert.equal((await visit(l.code, { ua: WHATSAPP })).status, 302);
    assert.equal((await visit(l.code)).status, 302, 'the real person still gets in');
    assert.equal((await visit(l.code, { ip: '198.51.100.99' })).status, 410);
  });

  test('a burst of clicks is written as one batch with the right totals', async () => {
    const u = await makeUser();
    const a = await makeLink(u);
    const b = await makeLink(u);
    await Promise.all([
      ...Array.from({ length: 120 }, (_, i) => visit(a.code, { ip: `192.0.2.${i % 40}` })),
      ...Array.from({ length: 30 }, () => visit(b.code)),
    ]);
    assert.equal(clicks.pendingCount(), 150);
    assert.equal(await clicks.flush(), 150);
    assert.equal((await linkRow(a.id)).click_count, 120);
    assert.equal((await linkRow(b.id)).click_count, 30);
    const { rows } = await query('SELECT link_id, clicks FROM link_daily ORDER BY link_id');
    assert.deepEqual(rows.map((r) => r.clicks), [120, 30]);
  });

  test('visitors are recognised within a day without storing their IP', async () => {
    const u = await makeUser();
    const l = await makeLink(u);
    await visit(l.code, { ip: '203.0.113.50' });
    await visit(l.code, { ip: '203.0.113.50' });
    await visit(l.code, { ip: '203.0.113.51' });
    await clicks.flush();
    const { rows } = await query('SELECT visitor FROM clicks ORDER BY id');
    assert.ok(rows.every((r) => /^[0-9a-f]{16}$/.test(r.visitor)));
    assert.equal(rows[0].visitor, rows[1].visitor, 'same person, same day, same hash');
    assert.notEqual(rows[0].visitor, rows[2].visitor);
    const dump = JSON.stringify((await query('SELECT * FROM clicks')).rows);
    assert.ok(!dump.includes('203.0.113'), 'no IP address anywhere in the click rows');
  });

  test('peeking at a link shows where it goes without counting a click', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { url: 'https://example.com/where', title: 'Where it goes' });
    const p = await api().get(`/api/peek/${l.code}`);
    assert.equal(p.status, 200);
    assert.equal(p.body.target, 'https://example.com/where');
    assert.equal(p.body.status, 'active');
    await clicks.flush();
    assert.equal((await linkRow(l.id)).click_count, 0);
    assert.equal((await api().get('/api/peek/zzzzzzz')).status, 404);
  });
});
