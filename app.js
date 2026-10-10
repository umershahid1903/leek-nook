import CONFIG from './config.js';
import { seal, b64u } from './mailbox.js';

const VERSION = '1.1.0';
const LIVE_EVERY = 10_000;
const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem('ln.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ln.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- formatting ----------
function capParts(n) {
  if (!(n > 0)) return { num: '…', unit: '' };
  if (n >= 1e9) return { num: (n / 1e9).toFixed(2), unit: 'B' };
  if (n >= 1e6) return { num: (n / 1e6).toFixed(n >= 1e8 ? 1 : 2), unit: 'M' };
  if (n >= 1e3) return { num: (n / 1e3).toFixed(1), unit: 'K' };
  return { num: String(Math.round(n)), unit: '' };
}
function money(n) {
  if (!(n >= 0)) return '…';
  const p = capParts(n);
  return '$' + p.num.replace(/\.0+$|(\.\d*?)0+$/, '$1') + p.unit;
}
function price(n) {
  if (!(n > 0)) return '…';
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toPrecision(4);
}
function pct(n) {
  if (n == null || !isFinite(n)) return '…';
  const a = Math.abs(n);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + (a >= 100 ? Math.round(a) : a.toFixed(1)) + '%';
}
function count(n) { return n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n.toLocaleString('en-US'); }
function clock(t, withDay) {
  const d = new Date(t);
  const s = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', ' ');
  return withDay ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + s : s;
}
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- lamp (theme) & greeting ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themeColor').content = theme === 'dark' ? '#262624' : '#faf9f5';
}
function setupLamp() {
  applyTheme(document.documentElement.dataset.theme);
  $('lamp').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set('theme', next);
    const l = $('lamp');
    l.classList.remove('tug'); void l.offsetWidth; l.classList.add('tug');
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!store.get('theme', null)) applyTheme(e.matches ? 'dark' : 'light');
  });
}
function greet() {
  const h = new Date().getHours();
  $('greet').textContent = h < 5 ? 'Up late, are we' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Cozy night in';
}

// ---------- the market ----------
let market = store.get('market', null); // last good reading, painted instantly on open
let shownCap = 0;
let tween = 0;

// The exact token count from the Solana blockchain. Public RPCs refuse web
// pages, so the night watch reads it and publishes it on the bell-state branch;
// GeckoTerminal's copy of the on-chain number is the fallback.
let supply = store.get('supply', null); // { n, at, from }
let supplyAt = 0;
async function refreshSupply() {
  if (Date.now() - supplyAt < 10 * 60_000) return;
  supplyAt = Date.now();
  const keep = (n, from) => { if (n > 0) { supply = { n, at: Date.now(), from }; store.set('supply', supply); return true; } return false; };
  try {
    const r = await fetch(`${CONFIG.stateBase}supply.json?t=${Math.floor(Date.now() / 600_000)}`, { cache: 'no-cache' });
    if (r.ok) { const j = await r.json(); if (j.mint === CONFIG.mint && keep(Number(j.supply), 'chain')) return; }
  } catch { /* try the next */ }
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${CONFIG.chain}/tokens/${CONFIG.mint}`, { headers: { accept: 'application/json' } });
    if (r.ok) keep(Number((await r.json()).data.attributes.normalized_total_supply), 'geckoterminal');
  } catch { supplyAt = 0; }
}

// Market cap = DexScreener's live price x the on-chain supply.
async function readMarket() {
  const [r] = await Promise.all([
    fetch(`https://api.dexscreener.com/tokens/v1/${CONFIG.chain}/${CONFIG.mint}`, { cache: 'no-store' }),
    refreshSupply(),
  ]);
  if (!r.ok) throw new Error('dexscreener ' + r.status);
  const best = (await r.json())
    .filter((p) => p.marketCap > 0 && Number(p.priceUsd) > 0)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best) throw new Error('no priced pair');
  const priceUsd = Number(best.priceUsd);
  const tokens = supply ? supply.n : best.marketCap / priceUsd;
  return {
    mc: priceUsd * tokens, price: priceUsd, supply: tokens, supplyFrom: supply ? supply.from : 'dexscreener',
    chg: best.priceChange || {}, pool: best.pairAddress, url: best.url, at: Date.now(),
  };
}

function paintCap(target) {
  cancelAnimationFrame(tween);
  const from = shownCap || target;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 700);
    const v = from + (target - from) * (1 - Math.pow(1 - k, 3));
    const p = capParts(v);
    $('mcNum').textContent = p.num;
    $('mcUnit').textContent = p.unit;
    if (k < 1) tween = requestAnimationFrame(step);
  };
  shownCap = target;
  if (from === target) step(t0 + 700); else tween = requestAnimationFrame(step);
}

function paintMarket(m, prev) {
  paintCap(m.mc);
  if (prev && prev.mc !== m.mc) {
    const el = $('mc');
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(m.mc > prev.mc ? 'flash-up' : 'flash-down');
    setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 60);
  }
  const move = (v, label) => `<b class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${pct(v)}</b> ${label}`;
  $('moves').innerHTML = `${move(m.chg.h1, 'this hour')} · ${move(m.chg.h24, 'today')}`;
  if (m.url) $('dexLink').href = m.url;
  paintBar();
}

function paintAgo() {
  const live = $('live');
  if (!market) { $('ago').textContent = 'waking up…'; return; }
  const stale = Date.now() - market.at > 45_000;
  live.classList.toggle('stale', stale);
  $('liveText').textContent = stale ? (navigator.onLine === false ? 'offline' : 'reconnecting') : 'live';
  $('ago').textContent = 'updated ' + ago(market.at);
}

let liveTimer;
let liveFails = 0;
async function liveTick() {
  clearTimeout(liveTimer);
  if (document.hidden) return;
  try {
    const m = await readMarket();
    const prev = market;
    market = m;
    store.set('market', m);
    liveFails = 0;
    paintMarket(m, prev);
    checkLocalGoal(m);
  } catch {
    liveFails++;
  }
  paintAgo();
  liveTimer = setTimeout(liveTick, liveFails ? Math.min(60_000, LIVE_EVERY * 2 ** liveFails) : LIVE_EVERY);
}

// ---------- the bar toward the goal ----------
let target = store.get('target', CONFIG.defaultTarget);

function paintBar() {
  $('goal').textContent = money(target);
  const tick = (n) => { const [d, u] = n >= 1e6 ? [1e6, 'M'] : [1e3, 'K']; const v = n / d; return '$' + (v >= 10 ? Math.round(v) : +v.toFixed(1)) + u; };
  $('tick1').textContent = tick(target / 3);
  $('tick2').textContent = tick(target * 2 / 3);
  if (!market) { $('note').textContent = '…'; return; }
  const mc = market.mc;
  const p = Math.min(1, mc / target);
  $('barWrap').style.setProperty('--p', (p * 100).toFixed(2));
  $('bar').setAttribute('aria-valuenow', Math.floor(p * 100));
  const h1 = market.chg.h1 ?? 0;
  const mood = p >= 1 ? 'bloom' : h1 > 3 ? 'happy' : h1 < -3 ? 'sleepy' : 'calm';
  const buddy = $('buddy');
  buddy.classList.remove('calm', 'happy', 'sleepy', 'bloom');
  buddy.classList.add(mood);
  if (p >= 1) {
    $('note').textContent = `Made it to ${money(target)}!`;
    $('mood').textContent = 'the little leek is in full bloom';
  } else {
    const x = target / mc;
    $('note').textContent = `${Math.max(1, Math.floor(p * 100))}% of the way · ${money(target - mc)} to go`;
    $('mood').textContent = {
      happy: 'perky and pleased this hour',
      sleepy: 'having a little nap this hour',
      calm: 'warm and snug this hour',
    }[mood] + ` · needs ×${x.toFixed(x >= 10 ? 0 : 1)}`;
  }
}

// ---------- the bell ----------
// One notification at the goal, and only when the nook is closed: while it's
// open the goal shows right here (bloom + petals). There is no "hung" popup;
// the night watch's public notes (state.json, keyed by a hash of this phone's
// secret device id) tell the page when it has picked the phone up.
const canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const STUCK_AFTER = 40 * 60_000; // not picked up by then → send the note again
let bell = store.get('bell', { hung: false });
const newDevice = () => b64u.enc(crypto.getRandomValues(new Uint8Array(18)));
let device = store.get('device', null);
if (!device) { device = newDevice(); store.set('device', device); store.set('deviceV', 2); }
if (store.get('deviceV', 1) < 2 && !store.get('bell', {}).hung) { device = newDevice(); store.set('device', device); store.set('deviceV', 2); }
let swReg = null;

async function deviceKey(d = device) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(d));
  return b64u.enc(h).slice(0, 22);
}

function saveBell(patch) { bell = { ...bell, ...patch }; store.set('bell', bell); paintBell(); }

function paintTargets() {
  const presets = [...$('targets').querySelectorAll('button[data-t]')];
  const preset = presets.find((b) => Number(b.dataset.t) === target);
  for (const b of presets) b.classList.toggle('on', b === preset || (!preset && b.dataset.t === 'custom'));
  $('customBtn').textContent = preset ? 'other' : money(target);
}

function setStatus(kind, text) {
  const s = $('bellStatus');
  s.className = 'status ' + kind;
  s.querySelector('span').textContent = text;
}

function paintBell() {
  paintTargets();
  const perm = canPush ? Notification.permission : 'denied';
  const broken = bell.hung && perm !== 'granted';
  const stuck = bell.hung && !bell.seen && Date.now() - (bell.needAt || 0) > STUCK_AFTER;
  $('bellIco').classList.toggle('hung', !!bell.hung && !broken && !bell.lost);
  const hangBtn = $('hangBtn');
  hangBtn.hidden = !!bell.hung && !broken && !stuck && !bell.lost;
  if (!hangBtn.disabled) hangBtn.textContent = bell.hung ? 'Hang it again' : 'Hang the bell';
  $('testBtn').hidden = !bell.hung || broken;
  $('downBtn').hidden = !bell.hung;
  if (!canPush) return setStatus('bad', "This browser can't ring. Open the nook in Chrome on your phone.");
  if (perm === 'denied') {
    return setStatus('bad', (bell.hung ? "Notifications for Leek Nook got switched off, so the bell can't ring. " : 'Chrome is blocking notifications here. ')
      + 'Long-press the app icon → App info → Notifications (or tap the icon left of the address in Chrome) and allow them, then tap Hang ' + (bell.hung ? 'it again.' : 'the bell.'));
  }
  if (broken) return setStatus('bad', "Notifications for Leek Nook are off, so the bell can't ring. Tap Hang it again to switch them back on.");
  if (!bell.hung) return setStatus('', `Not hung yet. Hang it and this phone gets one notification at ${money(target)} while the nook is closed.`);
  if (bell.lost) return setStatus('bad', "The night watch couldn't reach this phone. Tap Hang it again.");
  if (bell.rangAt && bell.rangTarget === target) return setStatus('ok', `Rang at ${clock(bell.rangAt, true)} for ${money(target)}. It rings again if the cap dips under ${money(target * CONFIG.rearmBelow)} and climbs back.`);
  if (bell.seen) return setStatus('ok', `Hung. The night watch has this phone and sends one notification at ${money(target)} while the nook is closed.`);
  if (stuck) return setStatus('wait', `The night watch hasn't picked it up since ${clock(bell.needAt)}. Sending the note again…`);
  return setStatus('wait', `Hung at ${clock(bell.needAt || bell.postedAt)}. The night watch picks it up within 5 to 15 minutes; it'll show here.`);
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.innerHTML = `<span class="spin"></span>${label}`; }
  else btn.textContent = btn.dataset.label || btn.textContent;
}

async function getSubscription(create) {
  const reg = swReg || await navigator.serviceWorker.ready;
  const key = b64u.dec(CONFIG.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const had = sub.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    if (had && b64u.enc(had) !== b64u.enc(key)) { await sub.unsubscribe(); sub = null; } // keys were rotated
  }
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sub;
}

// A brand-new Chrome profile can take a while to register for push; never spin forever.
const within = (ms, promise, what) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(what + ' took too long')), ms))]);

async function post(note) {
  const body = await seal(note, CONFIG.mailboxPublicKey);
  const r = await fetch(`https://ntfy.sh/${CONFIG.mailboxTopic}`, { method: 'POST', body });
  if (!r.ok) throw new Error('mailbox ' + r.status);
}

// Sends this phone's push address and goal. `fresh` asks the watch to start over
// with it (new address, new goal, or a re-hang); a plain refresh just keeps it current.
async function postHang(sub, fresh) {
  const at = Date.now();
  await within(20_000, post({ kind: 'hang', device, sub: sub.toJSON(), target, at, fresh }), 'the mailbox');
  saveBell({ hung: true, postedAt: at, endpoint: sub.endpoint, target, ...(fresh ? { needAt: at, seen: false, lost: false } : {}) });
  if (fresh) followWatch(60_000);
}

async function hang() {
  if (!canPush) return paintBell();
  const btn = $('hangBtn');
  busy(btn, true, 'Hanging…');
  try {
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') { paintBell(); if (perm === 'default') toast('The bell needs notifications to ring you.'); return; }
    const sub = await within(45_000, getSubscription(true), 'signing up for push');
    await postHang(sub, true);
    $('bellIco').classList.remove('ring'); void $('bellIco').offsetWidth; $('bellIco').classList.add('ring');
    toast('Bell hung. The night watch picks it up within a few minutes.');
  } catch (e) {
    toast("Couldn't hang the bell (" + (e.message || 'error') + '). Try again in a moment.', 4000);
  } finally {
    busy(btn, false);
    paintBell();
  }
}

async function takeDown() {
  const btn = $('downBtn');
  busy(btn, true, 'Taking down…');
  try {
    await post({ kind: 'unhang', device, at: Date.now() });
    const sub = await getSubscription(false);
    if (sub) await sub.unsubscribe();
    saveBell({ hung: false, seen: false, lost: false, rangAt: 0 });
    toast('Bell taken down. No more rings.');
  } catch (e) {
    toast("Couldn't reach the mailbox, try again in a moment.", 3500);
  } finally { busy(btn, false); paintBell(); }
}

async function testRing() {
  if (Notification.permission === 'default') await Notification.requestPermission();
  const reg = swReg || await navigator.serviceWorker.ready;
  await reg.showNotification('Test ring 🔔', {
    body: `This is how the bell sounds. CyberLeek is at ${market ? money(market.mc) : '…'} right now.`,
    tag: 'test', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', vibrate: [120, 60, 120],
    data: { shownAt: Date.now(), kind: 'test' },
  });
}

let retargetTimer;
function chooseTarget(t) {
  target = t;
  store.set('target', t);
  paintBell();
  paintBar();
  if (market) checkLocalGoal(market);
  if (!bell.hung) return;
  clearTimeout(retargetTimer);
  retargetTimer = setTimeout(async () => {
    try {
      await postHang(await getSubscription(true), true);
      toast(`The bell now rings at ${money(target)}.`);
    } catch { toast("Couldn't move the bell, try again in a moment.", 3500); }
  }, 700);
}

// While the nook is open the goal shows right here, no notification.
function checkLocalGoal(m) {
  const armed = store.get('localArmed', {});
  const key = String(target);
  if (m.mc >= target) {
    if (armed[key] === false) return;
    armed[key] = false;
    store.set('localArmed', armed);
    celebrate();
  } else if (m.mc < target * CONFIG.rearmBelow && armed[key] === false) {
    armed[key] = true;
    store.set('localArmed', armed);
  }
}

function celebrate() {
  const box = $('petals');
  toast(`It made it to ${money(target)}! 🌸`, 5000);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  box.innerHTML = '';
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
    p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
    p.style.animationDuration = 2.8 + Math.random() * 2.4 + 's';
    p.style.animationDelay = Math.random() * 1.2 + 's';
    box.appendChild(p);
  }
  setTimeout(() => { box.innerHTML = ''; }, 7000);
}

// A ring that arrives while the nook is open: the worker skipped the popup and tells us instead.
function onPush(p) {
  if (!p || p.kind !== 'ring') return;
  saveBell({ rangAt: p.at || Date.now(), rangTarget: p.target });
  if (p.target === target && market) checkLocalGoal({ ...market, mc: Math.max(market.mc, p.mc || 0, p.peak || 0) });
}

// The service worker writes down rings that came while the nook was closed.
async function readPushDiary() {
  try {
    const r = await (await caches.open('ln-diary')).match('diary.json');
    if (!r) return;
    const d = await r.json();
    if (d.ring && d.ring.at > (bell.rangAt || 0)) saveBell({ rangAt: d.ring.at, rangTarget: d.ring.target });
  } catch { /* nothing yet */ }
}

// Has the night watch picked this phone up? Its notes are public on the bell-state branch.
let watchTimer;
async function readWatch() {
  if (!bell.hung) return;
  try {
    const r = await fetch(`${CONFIG.stateBase}state.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const mine = (await r.json()).bells?.[await deviceKey()];
    if (!mine || mine.at < (bell.needAt || 0)) return;
    if (mine.gone) saveBell({ lost: true, seen: false });
    else saveBell({ seen: true, lost: false, ...(mine.firedAt > (bell.rangAt || 0) ? { rangAt: mine.firedAt, rangTarget: mine.target } : {}) });
  } catch { /* offline */ }
}
function followWatch(every) {
  clearTimeout(watchTimer);
  const tick = async () => {
    if (!document.hidden) await readWatch();
    if (bell.hung && !bell.seen && !bell.lost) watchTimer = setTimeout(tick, every);
  };
  watchTimer = setTimeout(tick, every);
}

// Keep the night watch's copy fresh. If Chrome dropped the push address (site
// data cleared, notifications toggled, app installed after hanging) a new one
// is made and sent; if the watch never picked it up, the note goes again.
async function refreshBell() {
  if (!bell.hung || !canPush || Notification.permission !== 'granted') return paintBell();
  try {
    // v1.0.x published device ids in the watch's notes; move to a fresh, never-published id.
    let oldDevice = store.get('oldDevice', null);
    if (store.get('deviceV', 1) < 2) {
      oldDevice = device;
      device = newDevice();
      store.set('device', device); store.set('deviceV', 2); store.set('oldDevice', oldDevice);
    }
    const sub = await getSubscription(true);
    const moved = sub.endpoint !== bell.endpoint;
    const stuck = !bell.seen && Date.now() - (bell.needAt || bell.postedAt || 0) > STUCK_AFTER;
    if (oldDevice || moved || stuck || bell.lost) await postHang(sub, true);
    else if (Date.now() - (bell.postedAt || 0) > 3 * 86400_000) await postHang(sub, false);
    if (oldDevice) { await post({ kind: 'unhang', device: oldDevice, at: Date.now() }); store.set('oldDevice', null); }
  } catch { /* try again next open */ }
  await readWatch();
  if (bell.hung && !bell.seen) followWatch(60_000);
  paintBell();
}

async function watchSeen() {
  try {
    const r = await fetch(`https://api.github.com/repos/${CONFIG.repo}/actions/workflows/${CONFIG.workflow}/runs?per_page=1&status=success`, { headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const run = (await r.json()).workflow_runs?.[0];
    if (!run) return;
    const t = Date.parse(run.updated_at);
    const late = Date.now() - t > 45 * 60_000;
    $('watchSeen').textContent = late
      ? `The night watch last looked ${ago(t)}; GitHub runs it late sometimes.`
      : `It last looked ${ago(t)}.`;
  } catch { /* offline */ }
}

function setupBell() {
  $('targets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.t === 'custom') {
      const row = $('customRow');
      row.hidden = !row.hidden;
      if (!row.hidden) { $('customIn').value = ''; $('customIn').focus(); }
      return;
    }
    $('customRow').hidden = true;
    chooseTarget(Number(b.dataset.t));
  });
  $('customRow').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = parseFloat($('customIn').value.replace(',', '.'));
    if (!(v >= 0.1 && v <= 1e6)) { toast('Pick a target in millions, like 45.'); return; }
    $('customRow').hidden = true;
    $('customIn').blur();
    chooseTarget(Math.round(v * 1e6));
  });
  $('hangBtn').addEventListener('click', hang);
  $('downBtn').addEventListener('click', takeDown);
  $('testBtn').addEventListener('click', () => testRing().catch(() => toast("Couldn't show a test ring.")));
  paintBell();
}

// ---------- install ----------
function setupInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || store.get('installDismissed', false)) return;
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('install').hidden = false;
  });
  addEventListener('appinstalled', () => { $('install').hidden = true; toast('Tucked in. Find Leek Nook on your home screen.'); });
  $('installBtn').addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') $('install').hidden = true;
    } else {
      $('installHint').textContent = 'In Chrome, tap ⋮ (top right) → Add to Home screen → Install.';
    }
  });
  // Some browsers never fire the prompt; show the manual way after a moment on phones.
  setTimeout(() => {
    if (!deferred && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      $('install').hidden = false;
      $('installHint').textContent = /iPhone|iPad/i.test(navigator.userAgent)
        ? 'Tap Share → Add to Home Screen.'
        : 'In Chrome, tap ⋮ (top right) → Add to Home screen → Install.';
      $('installBtn').hidden = true;
    }
  }, 4000);
}

// ---------- start ----------
async function start() {
  $('ver').textContent = 'v' + VERSION;
  greet();
  setupLamp();
  setupBell();
  setupInstall();
  if (market) { paintMarket(market); paintAgo(); } else paintBar();
  $('hero').addEventListener('click', () => { liveTick(); });
  setInterval(paintAgo, 1000);
  setInterval(greet, 60_000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'push') onPush(e.data.payload); });
    navigator.serviceWorker.register('sw.js').then((reg) => { swReg = reg; }).catch(() => {});
    navigator.serviceWorker.ready.then(() => { readPushDiary(); refreshBell(); });
  }

  await liveTick();
  watchSeen();
  setInterval(() => { if (!document.hidden) watchSeen(); }, 5 * 60_000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(liveTimer); return; }
    greet();
    liveTick();
    readPushDiary().then(refreshBell);
    watchSeen();
  });
}

start();
