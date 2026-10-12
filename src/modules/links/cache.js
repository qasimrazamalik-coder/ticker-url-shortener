/**
 * A small LRU cache with per-entry expiry, for code -> link lookups on the
 * redirect path.
 *
 * A JavaScript Map remembers insertion order, so "least recently used" is
 * simply the first key: on every hit the entry is deleted and re-inserted at
 * the end, and when the cache is full the first key is evicted.
 *
 * Misses are cached too (as null, briefly), so someone hammering a code that
 * does not exist cannot turn every request into a database query.
 *
 * With several server instances each has its own cache. An edit invalidates
 * the cache of the instance that made it at once; the others pick it up within
 * the TTL. That is why the TTL is short. Click limits are counted by the
 * database, never by the cache (see redirect/routes.js), so concurrent clicks
 * cannot exceed a limit; what can be one TTL stale on another instance is
 * only the fact that a link has a limit, if one was added after creation.
 */
const config = require('../../config');
class LruCache {
  constructor({ max = 10000, ttlMs = 60000, missTtlMs = 10000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.missTtlMs = missTtlMs;
    this.now = now;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** Returns { value } on a hit (value may be null for a cached miss), or undefined. */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (entry.expires <= this.now()) { this.map.delete(key); this.misses++; return undefined; }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return { value: entry.value };
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + (value === null ? this.missTtlMs : this.ttlMs) });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); this.hits = 0; this.misses = 0; }
  get size() { return this.map.size; }
}

// The one cache the redirect path and the link service share.
const linkCache = new LruCache({ max: config.cacheMaxEntries, ttlMs: config.cacheTtlSeconds * 1000 });

module.exports = { LruCache, linkCache };
