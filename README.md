# Leek Nook

A cozy little window on **CyberLeek**'s market cap (Solana, mint `ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg`), with a bell that rings your phone when it reaches **$30M** (or any goal you pick).

**Open it:** https://umershahid1903.github.io/leek-nook/

## On your Android phone

1. Open the link in **Chrome** → tap **Add it** (or ⋮ → *Add to Home screen* → *Install*).
2. Open Leek Nook from the home screen → **Hang the bell** → allow notifications.
3. Within ~5–15 minutes the bell card says **"Hung. The night watch has this phone…"**. There's no popup for that.

What rings: **one notification when the cap reaches your goal, and only while the nook is closed.** If it's open, the leek blooms and petals fall instead. **Test ring** shows what the notification looks like.

## How it works

- **Market cap** = DexScreener's live price × the exact token supply on the Solana blockchain (`getTokenSupply`; mint authority is revoked, so it can only shrink). The night watch reads the supply and publishes it as `supply.json` on the `bell-state` branch, because public Solana RPCs refuse web pages. The page falls back to GeckoTerminal's copy of the on-chain number.
- **The page** (`index.html`, `app.css`, `app.js`) refreshes every 10 s while open and shows the cap with a bar toward the goal.
- **The night watch** (`.github/workflows/bell.yml` → `bell/bell.mjs`) runs on GitHub Actions every ~5 minutes. It has two clocks. Each look queues the next one behind the `pause` environment's 4-minute wait timer, which holds the job without a runner. The `*/5` cron is a backup that restarts the chain if it ever stops. (The cron alone never fired in the repo's first two hours.) It reads the cap and the last 90 one-minute candles, so a spike between two runs still counts (candle bodies only, not single-trade wicks). It then sends one Web Push to every armed bell that reached its goal. The service worker (`sw.js`) shows it only if no Leek Nook window is on screen. A bell rings once, then re-arms after the cap falls under 90% of the goal.
- **The mailbox** (`mailbox.js`) is how the phone tells the night watch where to ring. The phone seals its push address with the watch's public key and posts it to a public [ntfy.sh](https://ntfy.sh) topic. Only the Actions secret can open it. The watch keeps the sealed notes in `state.json` on `bell-state`, filed under a hash of each phone's secret device id. The page reads that file to show "picked up".
- **Self-healing:** each time the nook opens it checks its push address. If Chrome dropped it (site data cleared, notifications toggled, app installed after hanging), it sends a new one. If the watch hasn't picked it up after 40 minutes, it sends the note again.
- Secrets (repo → Settings → Secrets → Actions): `VAPID_PRIVATE_KEY`, `MAILBOX_PRIVATE_JWK`. The public halves are in `config.js`.

## Tests (local, nothing touches the real bell)

```
cd bell && npm ci && cd ..
node tests/bell.e2e.mjs   # real push through Google FCM into a headless Chrome, test keys and topic
node tests/screens.mjs    # phone-size screenshots, light and dark → tests/out/
node tests/perf.mjs       # 6× slower CPU, counts tasks over 50 ms
node tests/live.e2e.mjs   # LIVE: hangs a test bell on github.io, runs the real watch, takes it down
node tests/serve.mjs      # serve at http://localhost:18777/leek-nook/
```

## Changing things

- Goal, coin, re-arm level: `config.js`.
- Icons: edit the drawing in `tools/make_icons.mjs`, then `node tools/make_icons.mjs`.
- New keys: `node tools/make_keys.mjs --force`, update both secrets, push. Phones must hang the bell again.
- Every release: bump `VERSION` in `app.js` and `sw.js`.
