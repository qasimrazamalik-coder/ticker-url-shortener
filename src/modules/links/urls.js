/**
 * What a short link may point at.
 *
 * Ticker never fetches the target itself, so this is not about protecting the
 * server (SSRF). It is about protecting the person who clicks: a trusted-looking
 * short link should not quietly send them to their own router's admin page,
 * run a script, or carry a "bank.com@evil.example" style credential trick.
 */
const net = require('net');
const config = require('../../config');
const { badRequest } = require('../../errors');

const invalid = (message) => badRequest('INVALID_URL', message);

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

/** Returns the normalized URL, or throws INVALID_URL with a reason a person can act on. */
function normalizeTarget(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw invalid('Paste the address you want to shorten.');
  // People paste "example.com/page" without a scheme; assume https.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;

  let url;
  try { url = new URL(raw); } catch { throw invalid('That does not look like a web address.'); }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Only http and https links can be shortened.');
  if (url.username || url.password) throw invalid('Links with a username or password in them are not allowed.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw invalid('That address only works on a private network.');
  }
  const ipVersion = net.isIP(host);
  if (ipVersion === 4 && isPrivateIPv4(host)) throw invalid('That address only works on a private network.');
  if (ipVersion === 6 && isPrivateIPv6(host)) throw invalid('That address only works on a private network.');
  if (!ipVersion && !host.includes('.')) throw invalid('Use a full domain name, like example.com.');

  if (url.host === new URL(config.publicBaseUrl).host) throw invalid('That is already a Ticker link.');
  if (url.href.length > 2048) throw invalid('That address is too long (2048 characters at most).');
  return url.href;
}

module.exports = { normalizeTarget, isPrivateIPv4, isPrivateIPv6 };
