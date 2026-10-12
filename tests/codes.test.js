// Pure unit tests: no database, no HTTP.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { codeForId, idForCode, permute, unpermute, toBase62, fromBase62, SPACE } = require('../src/modules/links/codes');
const { normalizeTarget } = require('../src/modules/links/urls');
const { LruCache } = require('../src/modules/links/cache');
const { classify, referrerHost } = require('../src/modules/redirect/agent');

describe('short codes', () => {
  test('base62 round-trips and pads to 7 characters', () => {
    for (const n of [0, 1, 61, 62, 3843, 1234567890, SPACE - 1]) {
      const s = toBase62(n);
      assert.equal(s.length, 7);
      assert.equal(fromBase62(s), n);
    }
  });

  test('the permutation is invertible and stays inside the code space', () => {
    const samples = [0, 1, 2, 3, 999, 2 ** 21, 2 ** 32 + 5, SPACE - 2, SPACE - 1];
    for (let i = 0; i < 500; i++) samples.push(Math.floor(Math.random() * SPACE));
    for (const x of samples) {
      const y = permute(x);
      assert.ok(y >= 0 && y < SPACE, `permute(${x}) = ${y} is out of range`);
      assert.equal(unpermute(y), x);
    }
  });

  test('ten thousand consecutive ids give ten thousand different codes', () => {
    const codes = new Set();
    for (let id = 1; id <= 10000; id++) {
      const c = codeForId(id);
      assert.match(c, /^[0-9A-Za-z]{7}$/);
      codes.add(c);
    }
    assert.equal(codes.size, 10000);
  });

  test('consecutive ids do not give neighbouring codes', () => {
    const a = fromBase62(codeForId(500));
    const b = fromBase62(codeForId(501));
    // With plain base62 these would differ by exactly 1.
    assert.ok(Math.abs(a - b) > 1000000, `codes too close: ${a} vs ${b}`);
    assert.equal(idForCode(codeForId(501)), 501);
  });

  test('a different secret gives different codes', () => {
    assert.notEqual(codeForId(42, 'secret-one'), codeForId(42, 'secret-two'));
    assert.equal(idForCode(codeForId(42, 'secret-one'), 'secret-one'), 42);
  });
});

describe('what a link may point at', () => {
  test('adds https when the scheme is missing and keeps ordinary links', () => {
    assert.equal(normalizeTarget('example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(normalizeTarget('  http://news.ycombinator.com/item?id=1 '), 'http://news.ycombinator.com/item?id=1');
    assert.equal(normalizeTarget('https://203.0.113.9/report'), 'https://203.0.113.9/report');
  });

  for (const [input, why] of [
    ['javascript:alert(1)', 'scripts'],
    ['ftp://files.example.com/x', 'other schemes'],
    ['https://bank.com@evil.example/login', 'credentials'],
    ['http://localhost:8080/admin', 'localhost'],
    ['http://192.168.1.1/', 'home router'],
    ['http://10.0.0.5/', 'private range'],
    ['http://172.20.1.1/', 'private range'],
    ['http://169.254.169.254/latest/meta-data', 'link-local'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://intranet/wiki', 'single-label host'],
    ['', 'empty'],
  ]) {
    test(`rejects ${why}: ${input || '(empty)'}`, () => {
      assert.throws(() => normalizeTarget(input), (e) => e.code === 'INVALID_URL');
    });
  }
});

describe('LRU cache', () => {
  test('evicts the least recently used entry, and expires entries', () => {
    let now = 0;
    const c = new LruCache({ max: 2, ttlMs: 100, missTtlMs: 10, now: () => now });
    c.set('a', 1); c.set('b', 2);
    c.get('a');               // a is now the most recent
    c.set('c', 3);            // so b is evicted
    assert.equal(c.get('b'), undefined);
    assert.deepEqual(c.get('a'), { value: 1 });
    c.set('missing', null);   // cached miss
    assert.deepEqual(c.get('missing'), { value: null });
    now = 20;
    assert.equal(c.get('missing'), undefined, 'misses expire sooner');
    now = 150;
    assert.equal(c.get('a'), undefined);
  });
});

describe('user agents', () => {
  test('tells phones, desktops and link previews apart', () => {
    assert.deepEqual(classify('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'),
      { device: 'mobile', browser: 'Safari' });
    assert.deepEqual(classify('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0'),
      { device: 'desktop', browser: 'Edge' });
    assert.equal(classify('WhatsApp/2.23.20.0 A').device, 'bot');
    assert.equal(classify('Slackbot-LinkExpanding 1.0').device, 'bot');
    assert.equal(classify('').device, 'bot');
    assert.equal(referrerHost('https://www.linkedin.com/feed/'), 'linkedin.com');
    assert.equal(referrerHost('not a url'), null);
  });
});
