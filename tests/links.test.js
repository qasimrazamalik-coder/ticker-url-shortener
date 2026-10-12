const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeLink, visit, query, close } = require('./helpers');
const { idForCode } = require('../src/modules/links/codes');

beforeEach(reset);
after(close);

describe('creating links', () => {
  test('a generated code is 7 characters and decodes back to the row id', async () => {
    const u = await makeUser();
    const a = await makeLink(u, { url: 'example.com/first' });
    const b = await makeLink(u);
    assert.match(a.code, /^[0-9A-Za-z]{7}$/);
    assert.equal(a.target, 'https://example.com/first');
    assert.equal(a.shortUrl, `http://localhost:3004/${a.code}`);
    assert.equal(idForCode(a.code), a.id);
    assert.equal(idForCode(b.code), b.id);
    assert.notEqual(a.code.slice(0, 5), b.code.slice(0, 5), 'neighbouring ids should not share a prefix');
  });

  test('custom aliases: valid ones work, reserved and malformed ones are refused', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { alias: 'spring-sale' });
    assert.equal(l.code, 'spring-sale');
    assert.equal(l.custom, true);

    const reserved = await api().post('/api/links').set(u.auth).send({ url: 'example.com', alias: 'Admin' });
    assert.equal(reserved.status, 409);
    assert.equal(reserved.body.error.code, 'ALIAS_RESERVED');

    const bad = await api().post('/api/links').set(u.auth).send({ url: 'example.com', alias: '-x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_ALIAS');
  });

  test('RACE: ten people claim the same alias at once, exactly one gets it', async () => {
    const users = await Promise.all(Array.from({ length: 10 }, makeUser));
    const results = await Promise.all(users.map((u) =>
      api().post('/api/links').set(u.auth).send({ url: `example.com/${u.id}`, alias: 'launch' })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    const losers = results.filter((r) => r.status === 409);
    assert.equal(losers.length, 9);
    assert.ok(losers.every((r) => r.body.error.code === 'ALIAS_TAKEN'));
  });

  test('unsafe targets are refused through the API too', async () => {
    const u = await makeUser();
    for (const url of ['javascript:alert(1)', 'http://192.168.0.1/', 'http://user:pw@example.com/']) {
      const r = await api().post('/api/links').set(u.auth).send({ url });
      assert.equal(r.status, 400, url);
      assert.equal(r.body.error.code, 'INVALID_URL');
    }
  });

  test('RACE: the rate limit lets exactly a burst of 10 through when 15 arrive together', async () => {
    const u = await makeUser();
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) =>
      api().post('/api/links').set(u.auth).send({ url: `example.com/${i}` })));
    assert.equal(results.filter((r) => r.status === 201).length, 10);
    const limited = results.filter((r) => r.status === 429);
    assert.equal(limited.length, 5);
    assert.ok(limited.every((r) => r.body.error.code === 'RATE_LIMITED' && Number(r.headers['retry-after']) >= 1));

    // Another account has its own bucket.
    const other = await makeUser();
    assert.equal((await api().post('/api/links').set(other.auth).send({ url: 'example.com' })).status, 201);
  });
});

describe('managing links', () => {
  test('listing is newest first, keyset-paginated, searchable, and private', async () => {
    const u = await makeUser();
    const stranger = await makeUser();
    // Inserted directly so the creation rate limit does not get in the way.
    await query(
      `INSERT INTO links (owner_id, code, target_url, title)
       SELECT $1, 'code' || n, 'https://example.com/' || n, CASE WHEN n % 5 = 0 THEN 'report ' || n ELSE '' END
         FROM generate_series(1, 25) n`, [u.id]);
    await makeLink(stranger, { title: 'report from someone else' });

    const page1 = await api().get('/api/links?limit=10').set(u.auth);
    assert.equal(page1.body.links.length, 10);
    assert.equal(page1.body.links[0].code, 'code25');
    assert.equal(page1.body.links[0].last14.length, 14);
    const page2 = await api().get(`/api/links?limit=10&cursor=${page1.body.nextCursor}`).set(u.auth);
    const page3 = await api().get(`/api/links?limit=10&cursor=${page2.body.nextCursor}`).set(u.auth);
    assert.equal(page3.body.links.length, 5);
    assert.equal(page3.body.nextCursor, null);
    const all = [...page1.body.links, ...page2.body.links, ...page3.body.links].map((l) => l.code);
    assert.equal(new Set(all).size, 25);

    const search = await api().get('/api/links?q=report').set(u.auth);
    assert.deepEqual(search.body.links.map((l) => l.title), ['report 25', 'report 20', 'report 15', 'report 10', 'report 5']);
  });

  test("someone else's link looks like it does not exist", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const l = await makeLink(owner);
    assert.equal((await api().get(`/api/links/${l.id}`).set(other.auth)).status, 404);
    assert.equal((await api().patch(`/api/links/${l.id}`).set(other.auth).send({ disabled: true })).status, 404);
    assert.equal((await api().delete(`/api/links/${l.id}`).set(other.auth)).status, 404);
    assert.equal((await api().get(`/api/links/${l.id}/stats`).set(other.auth)).status, 404);
  });

  test('changing the target takes effect on the very next click (cache invalidated)', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { url: 'https://example.com/old' });
    assert.equal((await visit(l.code)).headers.location, 'https://example.com/old'); // now cached
    await api().patch(`/api/links/${l.id}`).set(u.auth).send({ url: 'https://example.com/new' });
    assert.equal((await visit(l.code)).headers.location, 'https://example.com/new');
  });

  test('a code that was looked up before it existed works as soon as it is created', async () => {
    const u = await makeUser();
    assert.equal((await visit('fresh-name')).status, 404); // cached as a miss
    await makeLink(u, { alias: 'fresh-name' });
    assert.equal((await visit('fresh-name')).status, 302);
  });

  test('a deleted link stops working and its code is never handed out again', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { alias: 'old-promo' });
    await visit(l.code);
    assert.equal((await api().delete(`/api/links/${l.id}`).set(u.auth)).status, 204);
    assert.equal((await visit(l.code)).status, 404);
    const again = await api().post('/api/links').set(u.auth).send({ url: 'example.com/elsewhere', alias: 'old-promo' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALIAS_TAKEN');
  });

  test('a click limit cannot be set below the clicks already counted', async () => {
    const u = await makeUser();
    const l = await makeLink(u, { maxClicks: 10 });
    for (let i = 0; i < 3; i++) await visit(l.code);
    const r = await api().patch(`/api/links/${l.id}`).set(u.auth).send({ maxClicks: 2 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'BELOW_CLICK_COUNT');
    const ok = await api().patch(`/api/links/${l.id}`).set(u.auth).send({ maxClicks: 3 });
    assert.equal(ok.body.status, 'used_up');
  });
});
