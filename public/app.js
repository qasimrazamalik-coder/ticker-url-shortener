// Ticker frontend: plain JavaScript, no build step.

const $ = (id) => document.getElementById(id);
const $view = $('view');
const store = {
  get token() { try { return localStorage.getItem('tk.token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('tk.token', v) : localStorage.removeItem('tk.token'); } catch {} },
};
let me = null;
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => new Intl.NumberFormat('en').format(n);
const shortDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && store.token) { store.token = null; me = null; }
  if (!res.ok) {
    const e = new Error(data.error?.message || 'Request failed');
    e.code = data.error?.code; e.details = data.error?.details;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`Copied ${text}`);
}

function drawNav(current) {
  $('nav').innerHTML = me
    ? `<a href="#/" ${current === 'links' ? 'aria-current="page"' : ''}>Your links</a>
       <a href="/api/docs" target="_blank" rel="noopener">API</a>
       <span class="who">${esc(me.name)}</span><button id="out">Sign out</button>`
    : '<a href="/api/docs" target="_blank" rel="noopener">API</a>';
  $('out')?.addEventListener('click', () => { store.token = null; me = null; location.hash = '#/'; route(); });
}

// ---------- the tape ----------
function bars(values, label) {
  const max = Math.max(1, ...values);
  return `<div class="bars" role="img" aria-label="${esc(label)}">${values.map((v) =>
    `<i class="${v ? '' : 'zero'}" style="height:${Math.max(3, (v / max) * 100)}%" title="${v}"></i>`).join('')}</div>`;
}

function tape(l, { fresh = false, compact = false } = {}) {
  const url = new URL(l.shortUrl);
  const badge = l.status !== 'active' ? `<span class="badge ${l.status}">${{ disabled: 'Switched off', expired: 'Expired', used_up: 'Used up' }[l.status]}</span>`
    : l.maxClicks ? `<span class="badge limit">${l.clicks} of ${l.maxClicks} uses</span>` : '';
  const last = l.last14 || [];
  return `<li class="tape${fresh ? ' fresh' : ''}" data-id="${l.id}">
    <div class="left">
      <a class="code" href="${esc(l.shortUrl)}" target="_blank" rel="noopener"><span class="host">${esc(url.host)}/</span><span class="slug">${esc(l.code)}</span></a>${badge}
      <div class="dest">${l.title ? `<b>${esc(l.title)}</b> → ` : '→ '}${esc(l.target)}</div>
    </div>
    ${compact ? '' : `<div class="graph">${bars(last, `Clicks over the last 14 days: ${last.join(', ')}`)}<div class="hint">last 14 days</div></div>`}
    <div class="count"><strong>${num(l.clicks)}</strong>${l.clicks === 1 ? 'click' : 'clicks'}</div>
    <div class="acts">
      <button class="btn ghost small" data-copy="${esc(l.shortUrl)}">Copy</button>
      ${compact ? '' : `<a class="btn ghost small" href="#/link/${l.id}">Stats</a>`}
    </div>
  </li>`;
}

// ---------- your links ----------
let listState = { q: '', cursor: null, links: [] };

async function viewLinks() {
  drawNav('links');
  $view.innerHTML = `
    <h1>Your links</h1>
    <form class="shorten" id="shortenF" novalidate>
      <label for="url" class="sr">Long address</label>
      <div class="row">
        <input id="url" placeholder="Paste a long link, e.g. example.com/a/very/long/page" autocomplete="off" required>
        <button class="btn" id="shortenBtn">Shorten</button>
      </div>
      <button type="button" class="link-btn toggle-more" id="moreT" aria-expanded="false" aria-controls="more">Custom name, expiry or click limit</button>
      <div class="more" id="more" hidden>
        <div><label for="alias">Custom name</label><input id="alias" placeholder="spring-sale" autocomplete="off"></div>
        <div><label for="title">Note to yourself</label><input id="title" placeholder="Where you are sharing it" maxlength="120"></div>
        <div><label for="exp">Stops working on</label><input id="exp" type="datetime-local"></div>
        <div><label for="max">Click limit</label><input id="max" type="number" min="1" placeholder="No limit"></div>
      </div>
      <p class="err" id="shortenErr" hidden></p>
    </form>
    <div class="figures" id="figs"></div>
    <div class="list-head">
      <h2>All links</h2>
      <input id="q" type="search" placeholder="Search links" aria-label="Search links" value="${esc(listState.q)}">
    </div>
    <ul class="tapes" id="tapes"></ul>
    <button class="btn ghost more-btn" id="moreBtn" hidden>Show older links</button>`;

  $('moreT').onclick = () => {
    const open = $('more').hidden;
    $('more').hidden = !open;
    $('moreT').setAttribute('aria-expanded', String(open));
  };
  $('shortenF').onsubmit = shorten;
  let t;
  $('q').oninput = () => { clearTimeout(t); t = setTimeout(() => { listState.q = $('q').value.trim(); loadLinks(true); }, 250); };
  $('moreBtn').onclick = () => loadLinks(false);
  $view.onclick = (ev) => {
    const b = ev.target.closest('[data-copy]');
    if (b) copy(b.dataset.copy);
  };
  loadOverview();
  await loadLinks(true);
}

async function loadOverview() {
  const o = await api('/stats/overview');
  $('figs').innerHTML = `
    <div><strong>${num(o.links)}</strong>links</div>
    <div><strong>${num(o.today)}</strong>clicks today</div>
    <div><strong>${num(o.last7)}</strong>last 7 days</div>
    <div><strong>${num(o.allTime)}</strong>all time</div>
    <div class="month">${bars(o.series.map((d) => d.clicks), 'Clicks per day across all links, last 30 days')}<div class="hint">all links, last 30 days</div></div>`;
}

async function loadLinks(fromStart, freshId) {
  if (fromStart) listState = { ...listState, cursor: null, links: [] };
  const qs = new URLSearchParams({ limit: '10' });
  if (listState.q) qs.set('q', listState.q);
  if (listState.cursor) qs.set('cursor', listState.cursor);
  const page = await api(`/links?${qs}`);
  listState.links.push(...page.links);
  listState.cursor = page.nextCursor;
  $('tapes').innerHTML = listState.links.map((l) => tape(l, { fresh: l.id === freshId })).join('')
    || `<li class="empty">${listState.q ? 'Nothing matches that search.' : 'No links yet. Paste one above.'}</li>`;
  $('moreBtn').hidden = !page.nextCursor;
}

async function shorten(ev) {
  ev.preventDefault();
  const err = $('shortenErr');
  err.hidden = true;
  const body = { url: $('url').value.trim() };
  if ($('alias').value.trim()) body.alias = $('alias').value.trim();
  if ($('title').value.trim()) body.title = $('title').value.trim();
  if ($('exp').value) body.expiresAt = new Date($('exp').value).toISOString();
  if ($('max').value) body.maxClicks = Number($('max').value);
  $('shortenBtn').disabled = true;
  try {
    const l = await api('/links', { method: 'POST', body });
    $('shortenF').reset();
    listState.q = ''; $('q').value = '';
    await loadLinks(true, l.id);
    loadOverview();
    copy(l.shortUrl);
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    (ex.code?.startsWith('ALIAS') || ex.code === 'INVALID_ALIAS' ? $('alias') : $('url')).focus();
  } finally {
    $('shortenBtn').disabled = false;
  }
}

// ---------- one link ----------
let linkRange = 30;

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function chart(points, { label, axisEvery, axisLabel, cls = '' }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return `<div class="chart ${cls}" role="img" aria-label="${esc(label)}">${points.map((p) =>
      `<div class="col" title="${esc(p.title)}"><i class="${p.value ? '' : 'zero'}" style="height:${Math.max(1, (p.value / max) * 100)}%"></i></div>`).join('')}</div>
    <div class="axis">${points.map((p, i) => {
      const last = points.length - 1;
      // Label every Nth point and the last one, but skip a regular label that would crowd the last.
      const show = i === last || (i % axisEvery === 0 && last - i >= Math.ceil(axisEvery / 2));
      return `<span>${show ? esc(axisLabel(p, i)) : ''}</span>`;
    }).join('')}</div>`;
}

function ranked(rows, nameOf = (n) => n) {
  if (!rows.length) return '<p class="hint">No clicks in this period.</p>';
  const total = rows.reduce((n, r) => n + r.clicks, 0);
  return `<ul class="ranked">${rows.map((r) => `<li><span class="name">${esc(nameOf(r.name))}</span><span class="n">${num(r.clicks)}</span>
    <span class="meter"><span style="width:${(r.clicks / total) * 100}%"></span></span></li>`).join('')}</ul>`;
}

async function viewLink(id) {
  drawNav('');
  const s = await api(`/links/${id}/stats?days=${linkRange}&tz=${encodeURIComponent(browserZone)}`);
  const l = s.link;
  const every = linkRange <= 7 ? 1 : linkRange <= 30 ? 7 : 15;
  $view.innerHTML = `
    <a class="back" href="#/">← All links</a>
    <ul class="tapes link-head">${tape(l, { compact: true })}</ul>
    <div class="range" role="group" aria-label="Period">
      ${[7, 30, 90].map((d) => `<button data-days="${d}" aria-pressed="${d === linkRange}">${d} days</button>`).join('')}
      <span class="tz">Days and hours in ${esc(s.range.tz)}</span>
    </div>
    <div class="figures">
      <div><strong>${num(s.totals.clicks)}</strong>clicks</div>
      <div><strong>${num(s.totals.visitors)}</strong>visitors</div>
      <div><strong>${num(s.totals.allTime)}</strong>all time</div>
      <div><strong>${num(s.totals.botsIgnored)}</strong>previews and bots left out</div>
    </div>
    <section class="panel">
      <h3>Clicks per day</h3>
      ${chart(s.series.map((d) => ({ value: d.clicks, title: `${shortDay(d.day)}: ${plural(d.clicks, 'click')}, ${plural(d.visitors, 'visitor')}`, day: d.day })),
        { label: `Clicks per day from ${s.range.from} to ${s.range.to}`, axisEvery: every, axisLabel: (p) => shortDay(p.day) })}
      <p class="note">Visitors are recognised within a day only, without cookies or stored IP addresses, so the visitor total adds up each day's visitors.</p>
    </section>
    <div class="grid2">
      <section class="panel"><h3>Time of day</h3>
        ${chart(s.hours.map((h) => ({ value: h.clicks, title: `${String(h.hour).padStart(2, '0')}:00 - ${plural(h.clicks, 'click')}`, hour: h.hour })),
          { label: 'Clicks by hour of day', axisEvery: 6, axisLabel: (p) => `${String(p.hour).padStart(2, '0')}:00`, cls: 'hours' })}
      </section>
      <section class="panel"><h3>Where clicks came from</h3>${ranked(s.referrers, (n) => (n === 'direct' ? 'Direct, apps or email' : n))}</section>
    </div>
    <div class="grid3">
      <section class="panel"><h3>Devices</h3>${ranked(s.devices, (n) => n[0].toUpperCase() + n.slice(1))}</section>
      <section class="panel"><h3>Browsers</h3>${ranked(s.browsers)}</section>
      <section class="panel"><h3>Created</h3><p>${new Date(l.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</p>
        <p class="hint" style="margin-top:6px">${l.custom ? 'Custom name' : 'Generated code'}${l.updatedAt !== l.createdAt ? `, last changed ${new Date(l.updatedAt).toLocaleDateString('en-GB', { dateStyle: 'medium' })}` : ''}</p></section>
    </div>
    <section class="panel edit">
      <h3>Change this link</h3>
      <form id="editF">
        <div><label for="eUrl">Goes to</label><input id="eUrl" value="${esc(l.target)}" required></div>
        <div><label for="eTitle">Note to yourself</label><input id="eTitle" value="${esc(l.title)}" maxlength="120"></div>
        <div><label for="eExp">Stops working on</label><input id="eExp" type="datetime-local" value="${toLocalInput(l.expiresAt)}"><span class="hint">Leave empty for never.</span></div>
        <div><label for="eMax">Click limit</label><input id="eMax" type="number" min="1" value="${l.maxClicks ?? ''}" placeholder="No limit"></div>
        <label class="check full"><input type="checkbox" id="eOff" ${l.status === 'disabled' ? 'checked' : ''}> Switched off (people who click see a notice instead)</label>
        <div class="actions">
          <button class="btn">Save changes</button>
          <span class="err" id="editErr" hidden></span>
          <span class="spacer"></span>
          <button type="button" class="btn danger" id="delBtn">Delete link</button>
        </div>
      </form>
    </section>`;

  $view.onclick = (ev) => {
    const b = ev.target.closest('[data-copy]');
    if (b) return copy(b.dataset.copy);
    const d = ev.target.closest('[data-days]');
    if (d) { linkRange = Number(d.dataset.days); viewLink(id); }
  };

  $('editF').onsubmit = async (ev) => {
    ev.preventDefault();
    const changes = {};
    const url = $('eUrl').value.trim();
    if (url !== l.target) changes.url = url;
    if ($('eTitle').value.trim() !== l.title) changes.title = $('eTitle').value.trim();
    if ($('eExp').value !== toLocalInput(l.expiresAt)) changes.expiresAt = $('eExp').value ? new Date($('eExp').value).toISOString() : null;
    const max = $('eMax').value ? Number($('eMax').value) : null;
    if (max !== l.maxClicks) changes.maxClicks = max;
    if ($('eOff').checked !== (l.status === 'disabled')) changes.disabled = $('eOff').checked;
    if (!Object.keys(changes).length) return toast('Nothing changed.');
    try {
      await api(`/links/${id}`, { method: 'PATCH', body: changes });
      toast('Saved. The next click uses the new settings.');
      viewLink(id);
    } catch (ex) { $('editErr').textContent = ex.message; $('editErr').hidden = false; }
  };

  // Two-step delete instead of a confirm() dialog.
  let armed = null;
  $('delBtn').onclick = async () => {
    if (!armed) {
      $('delBtn').textContent = 'Click again to delete for good';
      armed = setTimeout(() => { armed = null; $('delBtn').textContent = 'Delete link'; }, 4000);
      return;
    }
    clearTimeout(armed);
    await api(`/links/${id}`, { method: 'DELETE' });
    toast(`Deleted. ${l.code} will never be given to another link.`);
    location.hash = '#/';
  };
}

// ---------- signed out ----------
function viewFront() {
  drawNav('');
  let mode = 'login';
  $view.innerHTML = `
    <div class="front">
      <div>
        <h1>Short links that tell you who clicked.</h1>
        <p class="lede">Shorten a link, share it anywhere, and see clicks per day, where they came from and what people used to open it. No cookies, no stored IP addresses.</p>
        <section class="peek">
          <h2>Got a short link? Check it first.</h2>
          <form id="peekF"><input id="peekIn" placeholder="localhost:3004/workshop" aria-label="Short link to check" autocomplete="off"><button class="btn ghost">Check</button></form>
          <div class="answer" id="peekOut" aria-live="polite"></div>
        </section>
      </div>
      <form class="auth" id="authF">
        <h2 id="authH">Sign in</h2>
        <div id="nameRow" hidden><label for="name">Your name</label><input id="name" autocomplete="name"></div>
        <div><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>
        <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required minlength="8"></div>
        <button class="btn" id="authBtn">Sign in</button>
        <p class="err" id="authErr" hidden></p>
        <p class="switch"><button type="button" class="link-btn" id="switchB">New here? Make an account</button></p>
        <p class="demo">Demo account: <button type="button" class="link-btn" id="demoB">demo@ticker.test</button>, password <code>password123</code></p>
      </form>
    </div>`;

  $('switchB').onclick = () => {
    mode = mode === 'login' ? 'register' : 'login';
    $('authH').textContent = $('authBtn').textContent = mode === 'login' ? 'Sign in' : 'Make an account';
    $('switchB').textContent = mode === 'login' ? 'New here? Make an account' : 'Already have an account? Sign in';
    $('nameRow').hidden = mode === 'login';
    $('pw').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  };
  $('demoB').onclick = () => { $('email').value = 'demo@ticker.test'; $('pw').value = 'password123'; };
  $('authF').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const body = { email: $('email').value, password: $('pw').value, ...(mode === 'register' ? { name: $('name').value } : {}) };
      const r = await api(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body });
      store.token = r.token; me = r.user;
      route();
    } catch (ex) { $('authErr').textContent = ex.message; $('authErr').hidden = false; }
  };
  $('peekF').onsubmit = async (ev) => {
    ev.preventDefault();
    const raw = $('peekIn').value.trim().replace(/\/+$/, '');
    const code = raw.split('/').pop();
    const out = $('peekOut');
    if (!code) return;
    try {
      const p = await api(`/peek/${encodeURIComponent(code)}`);
      const note = { active: '', disabled: ' It is switched off.', expired: ' It has expired.', used_up: ' It has been used up.' }[p.status];
      out.innerHTML = `<b>${esc(p.code)}</b> goes to <code>${esc(p.target)}</code>.${note}`;
    } catch (ex) {
      out.textContent = ex.code === 'NOT_FOUND' ? 'No Ticker link has that code.' : ex.message;
    }
  };
}

// ---------- router ----------
async function route() {
  if (store.token && !me) { try { me = await api('/auth/me'); } catch { me = null; } }
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  $view.onclick = null;
  try {
    if (!me) viewFront();
    else if (page === 'link') await viewLink(Number(arg));
    else await viewLinks();
  } catch (ex) {
    $view.innerHTML = `<h1>That didn't load</h1><p class="lede">${esc(ex.message)} <a href="#/">Back to your links</a>.</p>`;
  }
  if (page === 'link') $view.focus();
}
window.addEventListener('hashchange', route);
route();
