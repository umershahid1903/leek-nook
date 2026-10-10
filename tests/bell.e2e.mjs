// End-to-end test of the bell, for real: headless Chrome (a real FCM push
// subscription) → sealed note on a throwaway ntfy.sh topic → the night watch
// (bell.mjs, with fake market numbers) → real Web Push → the nook's service worker.
// Uses its own test keys and topic, so the real bell is never touched.
// `node tests/bell.e2e.mjs`
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { serve } from './serve.mjs';
import CONFIG from '../config.js';
import { makeMailboxKeys, seal } from '../mailbox.js';
import { runWatch, freshState, readMarket } from '../bell/bell.mjs';

const webpush = createRequire(import.meta.url)('../bell/node_modules/web-push');
const vapid = webpush.generateVAPIDKeys();
const mailbox = await makeMailboxKeys();
const topic = 'leeknook-test-' + Math.random().toString(36).slice(2, 12);
const cfg = { ...CONFIG, vapidPublicKey: vapid.publicKey, mailboxPublicKey: mailbox.publicKey, mailboxTopic: topic };
const deps = { jwk: mailbox.privateJwk, vapidPrivateKey: vapid.privateKey };

let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${what}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = (mc, candles = []) => async () => ({ mc, price: mc / 729.9e6, supply: 729.9e6, candles });

const port = 18900 + Math.floor(Math.random() * 90);
const origin = `http://localhost:${port}`;
const srv = await serve(port, { overrides: { 'config.js': `export default ${JSON.stringify(cfg)};` } });
const b = await launch();
const state = freshState();

try {
  // 0. the real market, read the way the night watch reads it
  const live = await readMarket(CONFIG);
  ok(live.mc > 1e5 && live.mc < 1e10 && live.candles.length > 30, 'night watch reads the live market', `cap $${(live.mc / 1e6).toFixed(2)}M, ${live.candles.length} candles`);

  await b.send('Browser.grantPermissions', { origin, permissions: ['notifications'] });
  const p = await b.newPage();
  await p.phone();
  await p.goto(`${origin}/leek-nook/`);
  await p.waitFor(`navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true)`);
  await p.waitFor(`document.getElementById('mcNum').textContent !== '…'`, 20000);

  const click = async (sel) => {
    const r = await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await sleep(150);
    for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const status = () => p.eval(`document.getElementById('bellStatus').className + ' | ' + document.getElementById('bellStatus').textContent`);
  const notes = () => p.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => ns.map((n) => n.title + ' — ' + n.body))`);
  const pushes = () => p.eval('window.__pushes ? window.__pushes.length : 0');
  await p.eval(`(() => {
    const of = window.fetch; window.fetch = (...a) => { console.log('fetch ' + String(a[0]).slice(0, 40)); return of(...a); };
    const os = PushManager.prototype.subscribe; PushManager.prototype.subscribe = function (...a) { console.log('subscribe…'); return os.apply(this, a).then((s) => { console.log('subscribed'); return s; }, (e) => { console.log('subscribe err ' + e.message); throw e; }); };
  })()`);
  await p.eval(`window.__pushes = []; navigator.serviceWorker.addEventListener('message', (e) => window.__pushes.push(e.data))`);
  const waitPush = async (n, what) => {
    try { await p.waitFor(`window.__pushes.length >= ${n}`, 40000); return true; } catch { ok(false, what + ' (no push arrived in 40 s)'); return false; }
  };

  // 1. hang the bell from the page
  await click('#hangBtn');
  try { await p.waitFor(`JSON.parse(localStorage.getItem('ln.bell') || '{}').hung === true`, 15000); }
  catch (e) { console.log('btn:', await p.eval(`document.getElementById('hangBtn').outerHTML`), 'perm:', await p.eval('Notification.permission'), 'toast:', await p.eval(`document.getElementById('toast').textContent`), '\nlogs:', p.logs.join('\n')); throw e; }
  ok((await status()).startsWith('status wait'), 'tapping “Hang the bell” posts a sealed note and waits', await status());

  // 2. the night watch picks it up and says hello
  await sleep(1500);
  let r = await runWatch(cfg, state, { ...deps, market: fake(3.9e6) });
  ok(r.tally.notes === 1 && r.tally.hung === 1, 'night watch opens the note and confirms the bell', r.log.at(-1));
  if (await waitPush(1, 'hello push')) {
    await sleep(500);
    ok((await status()).startsWith('status ok'), 'page shows the bell as confirmed', await status());
    ok((await notes()).some((t) => t.startsWith('The bell is hung')), 'phone shows the “bell is hung” notification', JSON.stringify(await notes()));
  }
  ok(!JSON.stringify(state).includes('fcm.googleapis.com'), 'stored state keeps the push address sealed');

  // 3. still below the goal: no ring
  r = await runWatch(cfg, state, { ...deps, market: fake(12e6) });
  ok(r.tally.rung === 0 && r.tally.notes === 0, 'no ring below the goal');

  // 4. cap reaches $30M: ring once
  r = await runWatch(cfg, state, { ...deps, market: fake(31.2e6) });
  ok(r.tally.rung === 1, 'rings when the cap reaches $30M', r.log.at(-1));
  if (await waitPush(2, 'ring push')) {
    await sleep(500);
    ok((await notes()).some((t) => t.startsWith('CyberLeek hit $30M!')), 'phone shows “CyberLeek hit $30M!”', JSON.stringify(await notes()));
    ok((await status()).includes('Rang at'), 'page notes when it rang', await status());
  }
  r = await runWatch(cfg, state, { ...deps, market: fake(32e6) });
  ok(r.tally.rung === 0, 'does not ring again while it stays above');

  // 5. dips under 90%, then a spike between two looks (only in the candles) rings again
  r = await runWatch(cfg, state, { ...deps, market: fake(26e6) });
  ok(r.log.some((l) => l.includes('re-armed')), 're-arms after dipping under $27M');
  const later = Date.now() + 5000;
  r = await runWatch(cfg, state, { ...deps, now: later + 60_000, market: fake(28.5e6, [{ t: later - 600_000, top: 40e6 }, { t: later + 30_000, top: 30.4e6 }]) });
  ok(r.tally.rung === 1, 'catches a spike to $30.4M that happened between two looks (and ignores one before re-arming)');
  if (await waitPush(3, 'spike push')) {
    await sleep(500);
    ok((await notes()).some((t) => t.includes('touched $30.4M')), 'spike ring says “touched $30.4M (now $28.5M)”', JSON.stringify(await notes()));
  }

  // 6. move the goal to $20M from the page → the watch re-confirms with the new goal
  await click('#targets button[data-t="20000000"]');
  await sleep(2500);
  r = await runWatch(cfg, state, { ...deps, market: fake(12e6) });
  ok(r.tally.notes === 1 && r.tally.hung === 1, 'changing the goal re-hangs the bell', r.log.at(-1));
  if (await waitPush(4, 'new-goal hello')) {
    await sleep(500);
    ok((await status()).includes('rings this phone at $20M'), 'page confirms the new $20M goal', await status());
  }

  // 7. junk and replays on the public topic are ignored
  const sealedOld = await seal({ kind: 'hang', device: 'A'.repeat(24), sub: { endpoint: 'https://evil.example/push', keys: { p256dh: 'x', auth: 'y' } }, target: 1e6, at: Date.now() }, mailbox.publicKey);
  await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: 'not a note' });
  await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: sealedOld });
  await sleep(1500);
  r = await runWatch(cfg, state, { ...deps, market: fake(12e6) });
  ok(r.tally.junk === 2 && Object.values(state.bells).filter((x) => !x.gone).length === 1, 'junk and non-push addresses are ignored', r.log.at(-1));

  // 8. take it down → no more rings, and an old “hang” replayed later can't bring it back
  await click('#downBtn');
  await p.waitFor(`JSON.parse(localStorage.getItem('ln.bell') || '{}').hung === false`, 15000);
  await sleep(1500);
  r = await runWatch(cfg, state, { ...deps, market: fake(45e6) });
  ok(r.tally.rung === 0 && Object.values(state.bells).every((x) => x.gone), 'taking it down silences the bell', r.log.at(-1));
  const replay = (await (await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.message.startsWith('{"v":1'));
  await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: replay.message });
  await sleep(1500);
  r = await runWatch(cfg, state, { ...deps, market: fake(45e6) });
  ok(r.tally.rung === 0 && r.tally.hung === 0, 'a replayed old note cannot re-hang it');

  // 9. while the nook is open it rings by itself (goal $1M, under the live cap)
  await click('#customBtn');
  await p.eval(`document.getElementById('customIn').value = '1'`);
  await click('#customRow button[type=submit]');
  await click('#hero');
  await sleep(2500);
  ok((await notes()).some((t) => t.startsWith('CyberLeek hit $1M!')), 'open nook rings on its own when the goal is reached', JSON.stringify(await notes()));
  ok(await p.eval(`document.getElementById('buddy').classList.contains('bloom')`), 'the little leek blooms at the goal');
  await p.shot(fileURLToPath(new URL('./out/bloom.png', import.meta.url)));

  const errs = p.logs.filter((l) => /exception|error/i.test(l) && !/api\.github\.com|404/.test(l));
  ok(errs.length === 0, 'no page errors', errs.join(' / '));
} catch (e) {
  ok(false, 'test crashed: ' + e.message);
} finally {
  await b.close();
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
