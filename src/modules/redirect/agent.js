/**
 * Just enough user-agent parsing for analytics: device class, browser family,
 * and whether it is a bot. Link previews (WhatsApp, Slack, Telegram ...) count
 * as bots: they fetch the link when someone pastes it, before anyone clicks.
 */
const BOT = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|slack|discord|skype|preview|embedly|curl\/|wget\/|python-requests|httpclient|okhttp|go-http-client|headless|lighthouse|monitor/i;

function classify(ua = '') {
  if (!ua.trim() || BOT.test(ua)) return { device: 'bot', browser: 'Bot' };
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet'
    : /Mobi|iPhone|iPod|Android/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS|Chromium/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari' : 'Other';
  return { device, browser };
}

/** "https://www.linkedin.com/feed/..." -> "linkedin.com"; null when absent or unreadable. */
function referrerHost(referrer) {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

module.exports = { classify, referrerHost };
