import CONFIG from './config.js';
import { seal, b64u } from './mailbox.js';

const VERSION = '1.0.1';
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

async function readMarket() {
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/${CONFIG.chain}/${CONFIG.mint}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('dexscreener ' + r.status);
  const best = (await r.json())
    .filter((p) => p.marketCap > 0 && Number(p.priceUsd) > 0)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best) throw new Error('no priced pair');
  const priceUsd = Number(best.priceUsd);
  return {
    mc: best.marketCap, fdv: best.fdv, price: priceUsd, supply: best.marketCap / priceUsd,
    liq: best.liquidity?.usd || 0, vol24: best.volume?.h24 || 0,
    chg: best.priceChange || {}, tx: best.txns?.h1 || { buys: 0, sells: 0 },
    pool: best.pairAddress, url: best.url, at: Date.now(),
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
    checkLocalRing(m);
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
const canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let bell = store.get('bell', { hung: false });
let device = store.get('device', null);
if (!device) { device = b64u.enc(crypto.getRandomValues(new Uint8Array(18))); store.set('device', device); }
let swReg = null;

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
  const ico = $('bellIco');
  ico.classList.toggle('hung', !!bell.hung);
  $('hangBtn').hidden = !!bell.hung;
  $('testBtn').hidden = !bell.hung;
  $('downBtn').hidden = !bell.hung;
  if (!canPush) return setStatus('bad', "This browser can't ring. Open the nook in Chrome on your phone.");
  if (Notification.permission === 'denied') {
    return setStatus('bad', 'Chrome is blocking notifications here. Tap the icon left of the address (or long-press the app icon → App info) and allow notifications.');
  }
  if (!bell.hung) return setStatus('', `Not hung yet. Hang it and this phone rings at ${money(target)}, even when the nook is closed.`);
  if (bell.rangAt && bell.rangTarget === target) return setStatus('ok', `Rang at ${clock(bell.rangAt, true)} for ${money(target)}. It rings again if the cap dips under ${money(target * CONFIG.rearmBelow)} and climbs back.`);
  if (bell.confirmedAt && bell.confirmedTarget === target) return setStatus('ok', `Hung and confirmed. The night watch rings this phone at ${money(target)}.`);
  return setStatus('wait', `Hung at ${clock(bell.postedAt)}. Waiting for the night watch to say hello, usually within 5 to 15 minutes.`);
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

async function hang() {
  if (!canPush) return paintBell();
  const btn = $('hangBtn');
  busy(btn, true, 'Hanging…');
  try {
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') { paintBell(); if (perm === 'default') toast('The bell needs notifications to ring you.'); return; }
    const sub = await within(45_000, getSubscription(true), 'signing up for push');
    await within(20_000, post({ kind: 'hang', device, sub: sub.toJSON(), target, at: Date.now() }), 'the mailbox');
    saveBell({ hung: true, postedAt: Date.now(), endpoint: sub.endpoint, target });
    $('bellIco').classList.remove('ring'); void $('bellIco').offsetWidth; $('bellIco').classList.add('ring');
    toast('Bell hung. The night watch will say hello soon.');
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
    saveBell({ hung: false, confirmedAt: 0, rangAt: 0 });
    toast('Bell taken down. No more rings.');
  } catch (e) {
    toast("Couldn't reach the mailbox, try again in a moment.", 3500);
  } finally { busy(btn, false); paintBell(); }
}

async function testRing() {
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
  if (market) checkLocalRing(market);
  if (!bell.hung) return;
  clearTimeout(retargetTimer);
  retargetTimer = setTimeout(async () => {
    try {
      const sub = await getSubscription(true);
      await post({ kind: 'hang', device, sub: sub.toJSON(), target, at: Date.now() });
      saveBell({ postedAt: Date.now(), endpoint: sub.endpoint, target });
      toast(`The bell now rings at ${money(target)}.`);
    } catch { toast("Couldn't move the bell, try again in a moment.", 3500); }
  }, 700);
}

// While the nook is open it watches too, so a crossing rings within seconds.
function checkLocalRing(m) {
  const armed = store.get('localArmed', {});
  const key = String(target);
  if (m.mc >= target) {
    if (armed[key] === false) return;
    armed[key] = false;
    store.set('localArmed', armed);
    celebrate();
    if (canPush && Notification.permission === 'granted') {
      (swReg ? Promise.resolve(swReg) : navigator.serviceWorker.ready).then((reg) => reg.showNotification(`CyberLeek hit ${money(target)}! 🌱`, {
        body: `Market cap is ${money(m.mc)} right now. Your leek is fully grown.`,
        tag: 'ring-' + target, renotify: true, requireInteraction: true, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
        vibrate: [200, 100, 200, 100, 400], data: { shownAt: Date.now(), kind: 'ring' },
      }));
    }
  } else if (m.mc < target * CONFIG.rearmBelow && armed[key] === false) {
    armed[key] = true;
    store.set('localArmed', armed);
  }
}

function celebrate() {
  const box = $('petals');
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
  toast(`It made it to ${money(target)}! 🌸`, 5000);
}

function onPush(p) {
  if (!p) return;
  if (p.kind === 'hung') saveBell({ confirmedAt: p.at || Date.now(), confirmedTarget: p.target });
  if (p.kind === 'ring') { saveBell({ rangAt: p.at || Date.now(), rangTarget: p.target }); if (!document.hidden && p.target === target) celebrate(); }
  $('bellIco').classList.remove('ring'); void $('bellIco').offsetWidth; $('bellIco').classList.add('ring');
}

// The service worker writes down every push it gets, so news that arrived while closed shows here.
async function readPushDiary() {
  try {
    const c = await caches.open('ln-diary');
    const r = await c.match('diary.json');
    if (!r) return;
    const d = await r.json();
    if (d.hung && d.hung.at > (bell.confirmedAt || 0)) onPush(d.hung);
    if (d.ring && d.ring.at > (bell.rangAt || 0)) saveBell({ rangAt: d.ring.at, rangTarget: d.ring.target });
  } catch { /* nothing yet */ }
}

// Keep the night watch's copy fresh: re-post if the phone's push address changed or every few days.
async function refreshBell() {
  if (!bell.hung || !canPush || Notification.permission !== 'granted') return;
  try {
    const sub = await getSubscription(true);
    if (sub.endpoint !== bell.endpoint || Date.now() - (bell.postedAt || 0) > 3 * 86400_000) {
      await post({ kind: 'hang', device, sub: sub.toJSON(), target, at: Date.now() });
      saveBell({ postedAt: Date.now(), endpoint: sub.endpoint });
    }
  } catch { /* try again next open */ }
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
    readPushDiary();
    watchSeen();
  });
}

start();
