// The night watch. GitHub Actions runs this every ~5 minutes:
//   1. read new notes from the mailbox (phones hanging / taking down a bell),
//   2. read CyberLeek's market cap (DexScreener) and the last 90 one-minute
//      candles (GeckoTerminal), so a spike between two runs is not missed,
//   3. ring every armed bell whose target was reached, via Web Push.
// State (sealed subscriptions, armed/fired flags) lives in state.json on the
// repo's `bell-state` branch. Logs are public, so they never print endpoints.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import config from '../config.js';
import { open } from '../mailbox.js';

const webpush = createRequire(import.meta.url)('web-push');

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/];
const MAX_BELLS = 10;
const HOUR = 3600_000;

export function money(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e8 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + Math.round(n);
}

export function freshState() {
  return { v: 1, cursor: 0, heartbeat: '', bells: {} };
}

export async function readMarket(cfg, fetchImpl = fetch) {
  const r = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${cfg.chain}/${cfg.mint}`);
  if (!r.ok) throw new Error('dexscreener ' + r.status);
  const best = (await r.json())
    .filter((p) => p.marketCap > 0 && Number(p.priceUsd) > 0)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best) throw new Error('dexscreener: no priced pair');
  const mc = best.marketCap;
  const price = Number(best.priceUsd);
  const supply = mc / price;
  let candles = [];
  try {
    const g = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/${cfg.chain}/pools/${best.pairAddress}/ohlcv/minute?aggregate=1&limit=90&currency=usd`, { headers: { accept: 'application/json' } });
    // Candle bodies only (open/close), so a one-trade wick doesn't ring the bell.
    if (g.ok) candles = (await g.json()).data.attributes.ohlcv_list.map(([t, o, , , c]) => ({ t: t * 1000, top: Math.max(o, c) * supply }));
  } catch { /* the current cap alone still works */ }
  return { mc, price, supply, candles };
}

export async function readMailbox(cfg, since, fetchImpl = fetch) {
  const r = await fetchImpl(`https://ntfy.sh/${cfg.mailboxTopic}/json?poll=1&since=${since ? Math.floor(since) : 'all'}`);
  if (!r.ok) throw new Error('mailbox ' + r.status);
  return (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m && m.event === 'message' && typeof m.message === 'string');
}

const hash = (s) => createHash('sha256').update(s).digest('base64url').slice(0, 16);

function validNote(n) {
  if (!n || (n.kind !== 'hang' && n.kind !== 'unhang')) return false;
  if (typeof n.device !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(n.device)) return false;
  if (typeof n.at !== 'number' || !isFinite(n.at)) return false;
  if (n.kind === 'unhang') return true;
  if (!(n.target >= 1e5 && n.target <= 1e12)) return false;
  const s = n.sub;
  if (!s || typeof s.endpoint !== 'string' || !s.keys?.p256dh || !s.keys?.auth) return false;
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch { return false; }
}

export function hungMessage(b, m) {
  return {
    kind: 'hung', target: b.target, mc: m?.mc ?? null, at: Date.now(),
    title: 'The bell is hung 🔔',
    body: `I'll ring this phone when CyberLeek reaches ${money(b.target)}.` + (m ? ` It's at ${money(m.mc)} now.` : ''),
  };
}

export function ringMessage(b, m, peak) {
  const holding = m.mc >= b.target;
  return {
    kind: 'ring', target: b.target, mc: m.mc, peak, price: m.price, at: Date.now(),
    title: `CyberLeek hit ${money(b.target)}! 🌱`,
    body: holding
      ? `Market cap is ${money(m.mc)} right now. Your leek is fully grown, come take a look.`
      : `It touched ${money(peak)} (now ${money(m.mc)}). Come take a look.`,
  };
}

/**
 * One look around. Mutates `state`, returns a log of what happened (no secrets).
 * deps: { jwk, vapidPrivateKey, fetch, market, send, now } — tests swap these.
 */
export async function runWatch(cfg, state, deps) {
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetch ?? fetch;
  const log = [];
  const tally = { notes: 0, junk: 0, hung: 0, rung: 0, gone: 0, failed: 0 };

  const send = deps.send ?? (async (sub, payload, urgent) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        TTL: urgent ? 6 * 3600 : 3600, urgency: urgent ? 'high' : 'normal', timeout: 15000,
        vapidDetails: { subject: `https://github.com/${cfg.repo}`, publicKey: cfg.vapidPublicKey, privateKey: deps.vapidPrivateKey },
      });
      return 'ok';
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) return 'gone';
      log.push(`push failed (${e.statusCode || e.code || 'error'})`);
      return 'fail';
    }
  });

  // 1. the mailbox
  try {
    for (const msg of await readMailbox(cfg, state.cursor, fetchImpl)) {
      state.cursor = Math.max(state.cursor || 0, msg.time || 0);
      let note;
      try { note = await open(msg.message, deps.jwk); } catch { tally.junk++; continue; }
      if (!validNote(note)) { tally.junk++; continue; }
      const cur = state.bells[note.device];
      if (cur && cur.at >= note.at) continue; // already seen (ntfy's `since` is inclusive), older, or replayed
      tally.notes++;
      if (note.kind === 'unhang') { state.bells[note.device] = { at: note.at, gone: true }; continue; }
      const live = Object.values(state.bells).filter((b) => !b.gone).length;
      if ((!cur || cur.gone) && live >= MAX_BELLS) { log.push('bell rack full, note ignored'); continue; }
      const ep = hash(note.sub.endpoint);
      if (cur && !cur.gone && cur.ep === ep && cur.target === note.target) {
        Object.assign(cur, { at: note.at, sealed: msg.message }); // same phone, same target: just refreshed
      } else {
        state.bells[note.device] = {
          sealed: msg.message, ep, at: note.at, target: note.target,
          confirmed: 0, armed: true, watchFrom: Math.min(now, Math.max(note.at, now - HOUR)), firedAt: 0,
        };
      }
    }
  } catch (e) { log.push('mailbox unreachable: ' + e.message); }

  // 2. the market
  let market = null;
  try { market = deps.market ? await deps.market() : await readMarket(cfg, fetchImpl); }
  catch (e) { log.push('market unreachable: ' + e.message); }
  if (market) log.push(`market cap ${money(market.mc)} (${market.candles.length} candles)`);

  // 3. the bells
  for (const [device, b] of Object.entries(state.bells)) {
    if (b.gone) continue;
    let sub;
    try { sub = (await open(b.sealed, deps.jwk)).sub; } catch { log.push('a sealed bell no longer opens; dropped'); delete state.bells[device]; continue; }

    if (!b.confirmed) {
      const r = await send(sub, hungMessage(b, market), false);
      if (r === 'gone') { state.bells[device] = { at: b.at, gone: true }; tally.gone++; continue; }
      if (r === 'ok') { b.confirmed = now; tally.hung++; } else tally.failed++;
    }
    if (!market) continue;

    if (b.armed) {
      let peak = market.mc;
      for (const c of market.candles) if (c.t >= b.watchFrom && c.top > peak) peak = c.top;
      if (peak >= b.target) {
        const r = await send(sub, ringMessage(b, market, peak), true);
        if (r === 'gone') { state.bells[device] = { at: b.at, gone: true }; tally.gone++; continue; }
        if (r === 'ok') { b.armed = false; b.firedAt = now; tally.rung++; } else tally.failed++;
      }
    } else if (market.mc < b.target * cfg.rearmBelow) {
      b.armed = true; b.watchFrom = now;
      log.push(`a bell re-armed (cap under ${Math.round(cfg.rearmBelow * 100)}% of its target)`);
    }
  }

  // Forget tombstones older than the mailbox's 12 h memory (replays can't reach past that).
  for (const [device, b] of Object.entries(state.bells)) if (b.gone && now - b.at > 2 * 24 * HOUR) delete state.bells[device];

  // Touch the state once a month, so the repo never looks idle to GitHub's 60-day rule.
  state.heartbeat = new Date(now).toISOString().slice(0, 7);

  const live = Object.values(state.bells).filter((b) => !b.gone);
  log.push(`bells: ${live.length} hung, ${live.filter((b) => b.armed).length} armed · notes ${tally.notes} (junk ${tally.junk}) · confirmed ${tally.hung} · rang ${tally.rung} · gone ${tally.gone} · failed ${tally.failed}`);
  return { log, tally, market };
}

async function main() {
  const file = process.env.STATE_FILE || 'state.json';
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : freshState();
  const before = JSON.stringify(state);
  if (!process.env.MAILBOX_PRIVATE_JWK || !process.env.VAPID_PRIVATE_KEY) throw new Error('missing secrets MAILBOX_PRIVATE_JWK / VAPID_PRIVATE_KEY');
  const { log } = await runWatch(config, state, {
    jwk: JSON.parse(process.env.MAILBOX_PRIVATE_JWK),
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  });
  for (const line of log) console.log(line);
  if (JSON.stringify(state) !== before) {
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
    console.log('state changed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
