// End-to-end test of the bell, for real: headless Chrome (a real FCM push
// subscription) → sealed note on a throwaway ntfy.sh topic → the night watch
// (bell.mjs, with fake market numbers) → real Web Push → the nook's service worker.
// Uses its own test keys, topic and state, so the real bell is never touched.
// The rules under test: one notification at the goal and only while the nook is
// closed; on screen the goal shows as a bloom; no "hung" popup; Test ring stays.
// `node tests/bell.e2e.mjs`
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { serve } from './serve.mjs';
import CONFIG from '../config.js';
import { makeMailboxKeys, seal } from '../mailbox.js';
import { runWatch, freshState, readMarket, readSupply, deviceKey } from '../bell/bell.mjs';

const webpush = createRequire(import.meta.url)('../bell/node_modules/web-push');
const vapid = webpush.generateVAPIDKeys();
const mailbox = await makeMailboxKeys();
const topic = 'leeknook-test-' + Math.random().toString(36).slice(2, 12);
const port = 18900 + Math.floor(Math.random() * 90);
const origin = `http://localhost:${port}`;
const cfg = { ...CONFIG, vapidPublicKey: vapid.publicKey, mailboxPublicKey: mailbox.publicKey, mailboxTopic: topic, stateBase: `${origin}/leek-nook/test-state/` };
const deps = { jwk: mailbox.privateJwk, vapidPrivateKey: vapid.privateKey };

let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${what}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = (mc, candles = []) => async () => ({ mc, price: mc / 729.9e6, supply: 729.9e6, candles });

const overrides = { 'config.js': `export default ${JSON.stringify(cfg)};` };
const srv = await serve(port, { overrides });
const b = await launch();
const state = freshState();
const publish = () => { overrides['test-state/state.json'] = JSON.stringify(state); };
publish();

try {
  // 0. the market: DexScreener's price × the exact on-chain supply
  const chain = await readSupply(CONFIG);
  overrides['test-state/supply.json'] = JSON.stringify({ mint: CONFIG.mint, supply: chain });
  const live = await readMarket(CONFIG, fetch, chain);
  const ds = (await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${CONFIG.mint}`)).json())[0];
  ok(Number(chain) > 7e8 && Number(chain) < 1e9, 'reads the exact supply from the Solana blockchain', chain);
  ok(live.supplySource === 'chain' && Math.abs(live.mc - live.price * Number(chain)) < 1, 'market cap = price × on-chain supply', `$${live.mc.toFixed(0)} = ${live.price} × ${chain}`);
  ok(Math.abs(live.mc / ds.marketCap - 1) < 0.005 && live.candles.length > 30, 'agrees with DexScreener within 0.5%', `ours $${live.mc.toFixed(0)} vs DexScreener $${ds.marketCap} (${(100 * (live.mc / ds.marketCap - 1)).toFixed(3)}%)`);
  const noRpc = (u, o) => (String(u).includes('solana.com') ? Promise.reject(new Error('rpc down')) : fetch(u, o));
  const r0 = await runWatch(cfg, freshState(), { ...deps, fetch: noRpc, lastSupply: chain });
  ok(r0.log.some((l) => l.includes('using the last known one')) && r0.market?.supplySource === 'chain', 'if the blockchain RPC is down, the watch uses the last known supply', r0.log[0]);

  await b.send('Browser.grantPermissions', { origin, permissions: ['notifications'] });
  let p = await b.newPage();
  await p.phone();
  const open = async () => {
    await p.goto(`${origin}/leek-nook/`);
    await p.waitFor(`document.getElementById('mcNum').textContent !== '…'`, 20000);
    await p.eval(`window.__pushes = []; navigator.serviceWorker.addEventListener('message', (e) => window.__pushes.push(e.data)); true`);
    await sleep(1200);
  };
  const click = async (sel) => {
    const r = await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await sleep(150);
    for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const status = () => p.eval(`document.getElementById('bellStatus').className + ' | ' + document.getElementById('bellStatus').textContent`);
  const notes = () => p.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => ns.map((n) => n.title + ' — ' + n.body))`);
  const clearNotes = () => p.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => { ns.forEach((n) => n.close()); return true; })`);
  const posted = (after) => p.waitFor(`(JSON.parse(localStorage.getItem('ln.bell') || '{}').postedAt || 0) > ${after}`, 50000);
  const watch = async (market) => { await sleep(1500); const r = await runWatch(cfg, state, { ...deps, market }); publish(); return r; };
  await open();

  // 1. hang the bell: no popup, the page waits for the watch
  await click('#hangBtn');
  await posted(0);
  ok((await status()).startsWith('status wait'), 'tapping “Hang the bell” sends the sealed note and waits', await status());

  // 2. the watch picks it up WITHOUT a push; the page learns it from the public notes
  let r = await watch(fake(3.9e6));
  ok(r.tally.notes === 1 && r.tally.picked === 1 && r.tally.failed === 0, 'night watch picks the bell up without sending anything', r.log.at(-1));
  await sleep(4000);
  ok((await notes()).length === 0, 'no “bell is hung” popup on the phone', JSON.stringify(await notes()));
  await open();
  ok((await status()).startsWith('status ok') && /has this phone/.test(await status()), 'the page shows it was picked up', await status());
  const device = await p.eval(`JSON.parse(localStorage.getItem('ln.device'))`);
  ok(Object.keys(state.bells).every((k) => k.length === 22) && !JSON.stringify(state).includes(device) && !!state.bells[deviceKey(device)], 'public notes file the bell under a hash, never the device id');
  ok(!JSON.stringify(state).includes('fcm.googleapis.com'), 'public notes keep the push address sealed');

  // 3. below the goal: nothing
  r = await watch(fake(12e6));
  ok(r.tally.rung === 0, 'no ring below the goal');

  // 4. goal reached while the nook is ON SCREEN → no popup, it blooms instead
  r = await watch(fake(31.2e6));
  ok(r.tally.rung === 1, 'night watch rings at $30M', r.log.at(-1));
  try {
    await p.waitFor('window.__pushes.some((m) => m.payload && m.payload.kind === "ring")', 40000);
    await sleep(1500);
    ok((await notes()).length === 0, 'nook on screen: no notification popup', JSON.stringify(await notes()));
    ok(await p.eval(`document.getElementById('toast').textContent.includes('It made it to $30M')`) && (await status()).includes('Rang at'), 'nook on screen: it shows on the page instead (petals, “Rang at”)', await status());
  } catch { ok(false, 'the ring push never reached the open nook'); }

  r = await watch(fake(32e6));
  ok(r.tally.rung === 0, 'does not ring again while it stays above');
  r = await watch(fake(26e6));
  ok(r.log.some((l) => l.includes('re-armed')), 're-arms after dipping under $27M');

  // 5. goal reached while the nook is CLOSED → exactly one notification
  // Peek at the service worker's diary (which rings it received) without opening a nook window.
  const diaryAt = async () => {
    const { targetInfos } = await b.send('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'service_worker' && x.url.includes('/leek-nook/sw.js'));
    if (!t) return 0;
    try {
      const { sessionId } = await b.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await b.send('Runtime.evaluate', { expression: `caches.open('ln-diary').then((c) => c.match('diary.json')).then((r) => (r ? r.json() : {})).then((d) => (d.ring && d.ring.at) || 0)`, awaitPromise: true, returnByValue: true }, sessionId);
      await b.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      return r.result.value || 0;
    } catch { return 0; }
  };
  await clearNotes();
  await b.send('Target.closeTarget', { targetId: p.targetId });
  const outside = await b.newPage(); // about:blank: not one of the nook's windows
  const before = await diaryAt();
  const later = Date.now() + 5000;
  r = await runWatch(cfg, state, { ...deps, now: later + 60_000, market: fake(28.5e6, [{ t: later - 600_000, top: 40e6 }, { t: later + 30_000, top: 30.4e6 }]) });
  publish();
  ok(r.tally.rung === 1, 'catches a spike to $30.4M between two looks (ignores one from before re-arming)');
  let arrived = false;
  for (let i = 0; i < 40 && !arrived; i++) { await sleep(1000); arrived = (await diaryAt()) > before; }
  ok(arrived, 'the ring reached the closed nook');
  p = outside;
  await p.phone();
  await open();
  const shown = await notes();
  ok(shown.length === 1 && shown[0].includes('touched $30.4M'), 'nook closed: exactly one notification, “CyberLeek hit $30M!… touched $30.4M”', JSON.stringify(shown));
  ok((await status()).includes('Rang at'), 'reopening shows when it rang', await status());
  await clearNotes();

  // 6. moving the goal re-hangs it
  const t6 = Date.now();
  await click('#targets button[data-t="20000000"]');
  await posted(t6);
  r = await watch(fake(12e6));
  ok(r.tally.notes === 1 && r.tally.picked === 1, 'changing the goal re-hangs the bell', r.log.at(-1));
  await open();
  ok((await status()).startsWith('status ok') && (await status()).includes('$20M'), 'page confirms the new $20M goal', await status());

  // 7. Chrome drops the push address (what happened to the first real bell) → reopening heals it
  await p.eval(`navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => s.unsubscribe())`);
  const t7 = Date.now();
  await open();
  await posted(t7);
  r = await watch(fake(12e6));
  ok(r.tally.notes === 1 && r.tally.picked === 1, 'reopening after the address was dropped sends a new one by itself', r.log.at(-1));
  await open();
  ok((await status()).startsWith('status ok'), 'healed bell shows as picked up', await status());

  // 8. notifications switched off → the page says so and offers “Hang it again”
  await b.send('Browser.setPermission', { origin, permission: { name: 'notifications' }, setting: 'denied' });
  await open();
  const offStatus = await status();
  const offBtn = await p.eval(`(() => { const h = document.getElementById('hangBtn'); return h.hidden ? 'hidden' : h.textContent; })()`);
  ok(offStatus.startsWith('status bad') && /switched off/.test(offStatus) && offBtn === 'Hang it again', 'switched-off notifications are shown, with “Hang it again”', `button: ${offBtn}`);
  await b.send('Browser.setPermission', { origin, permission: { name: 'notifications' }, setting: 'granted' });
  const t8 = Date.now();
  await open(); // the nook may re-hang by itself here (Chrome dropped the address with the permission)
  if (!(await p.eval(`document.getElementById('hangBtn').hidden`))) await click('#hangBtn');
  let reposted = true;
  try { await p.waitFor(`(JSON.parse(localStorage.getItem('ln.bell') || '{}').postedAt || 0) > ${t8}`, 10000); } catch { reposted = false; }
  if (reposted) {
    r = await watch(fake(12e6));
    ok(r.tally.picked === 1, 'after allowing again: Chrome had dropped the address, a new one was sent and picked up', r.log.at(-1));
  } else {
    const same = await p.eval(`navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => s && s.endpoint === JSON.parse(localStorage.getItem('ln.bell')).endpoint)`);
    ok(same, 'after allowing again: Chrome kept the same push address, nothing to re-send');
  }
  await open();
  ok((await status()).startsWith('status ok'), 'page shows the bell as hung again', await status());

  // 9. not picked up for 40+ min → the nook sends the note again by itself
  await p.eval(`(() => { const b = JSON.parse(localStorage.getItem('ln.bell')); b.seen = false; b.needAt = b.postedAt = Date.now() - 41 * 60000; localStorage.setItem('ln.bell', JSON.stringify(b)); })()`);
  const t9 = Date.now();
  await open();
  await posted(t9);
  r = await watch(fake(12e6));
  ok(r.tally.picked === 1, 'a bell not picked up for 40 min re-sends its note', r.log.at(-1));

  // 10. phones from v1.0.x move to a never-published device id; the old entry is taken down
  const oldDev = await p.eval(`JSON.parse(localStorage.getItem('ln.device'))`);
  await p.eval(`localStorage.setItem('ln.deviceV', '1')`);
  const t10 = Date.now();
  await open();
  await posted(t10);
  await sleep(1500);
  r = await watch(fake(12e6));
  const newDev = await p.eval(`JSON.parse(localStorage.getItem('ln.device'))`);
  ok(newDev !== oldDev && state.bells[deviceKey(oldDev)]?.gone && state.bells[deviceKey(newDev)] && !state.bells[deviceKey(newDev)].gone, 'old device id retired, bell moved to a fresh one', r.log.at(-1));
  await open();
  ok((await status()).startsWith('status ok'), 'and it shows as picked up', await status());

  // 11. v1 notes (raw device ids) are re-filed under hashes
  const v1 = { v: 1, cursor: 0, heartbeat: '', bells: { rawDeviceId_abcdefghijkl: { at: Date.now(), gone: true } } };
  await runWatch({ ...cfg, mailboxTopic: topic + 'x' }, v1, { ...deps, market: fake(1e6) });
  ok(v1.v === 2 && !JSON.stringify(v1).includes('rawDeviceId') && !!v1.bells[deviceKey('rawDeviceId_abcdefghijkl')], 'v1 notes are migrated to hashed keys');

  // 12. junk and foreign push addresses on the public topic are ignored
  await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: 'not a note' });
  await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: await seal({ kind: 'hang', device: 'A'.repeat(24), sub: { endpoint: 'https://evil.example/push', keys: { p256dh: 'x', auth: 'y' } }, target: 1e6, at: Date.now() }, mailbox.publicKey) });
  r = await watch(fake(12e6));
  ok(r.tally.junk === 2 && Object.values(state.bells).filter((x) => !x.gone).length === 1, 'junk and non-push addresses are ignored', r.log.at(-1));

  // 13. take it down → no ring; an old note replayed later can't re-hang it
  await click('#downBtn');
  await p.waitFor(`JSON.parse(localStorage.getItem('ln.bell') || '{}').hung === false`, 15000);
  r = await watch(fake(45e6));
  ok(r.tally.rung === 0 && Object.values(state.bells).every((x) => x.gone), 'taking it down silences the bell', r.log.at(-1));
  const replay = (await (await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.message.startsWith('{"v":1'));
  await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: replay.message });
  r = await watch(fake(45e6));
  ok(r.tally.rung === 0 && r.tally.picked === 0, 'a replayed old note cannot re-hang it');

  // 14. goal reached while the nook is open: blooms, no popup
  await clearNotes();
  await click('#customBtn');
  await p.eval(`document.getElementById('customIn').value = '1'`);
  await click('#customRow button[type=submit]');
  await sleep(2500);
  ok((await notes()).length === 0, 'goal reached with the nook open: no notification', JSON.stringify(await notes()));
  ok(await p.eval(`document.getElementById('buddy').classList.contains('bloom') && document.getElementById('toast').textContent.includes('It made it to $1M')`), 'the little leek blooms and petals fall');
  await p.shot(fileURLToPath(new URL('./out/bloom.png', import.meta.url)));

  // 15. Test ring stays
  await click('#targets button[data-t="30000000"]');
  const t15 = Date.now();
  await click('#hangBtn');
  await posted(t15);
  await click('#testBtn');
  await sleep(1500);
  ok((await notes()).some((t) => t.startsWith('Test ring')), 'Test ring still shows a notification', JSON.stringify(await notes()));

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
