// Phone-speed check: 6× CPU slowdown, counts main-thread tasks over 50 ms
// during load and 25 s of live updates. `node tests/perf.mjs`
import { launch } from './cdp.mjs';
import { serve } from './serve.mjs';
const port = 18850 + Math.floor(Math.random() * 40);
const srv = await serve(port);
const b = await launch();
let failed = false;
try {
  const p = await b.newPage();
  await p.phone();
  await p.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true });` });
  const t0 = Date.now();
  await p.goto(`http://localhost:${port}/leek-nook/`);
  await p.waitFor(`document.getElementById('mcNum').textContent !== '…'`, 30000);
  console.log('first number on screen after', Date.now() - t0, 'ms (6× slower CPU, live network)');
  const fcp = await p.eval(`(performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime | 0`);
  console.log('first contentful paint', fcp, 'ms');
  await new Promise((r) => setTimeout(r, 25000));
  const long = await p.eval('window.__long');
  const worst = Math.max(0, ...long);
  console.log('tasks over 50 ms:', long.length, long.join(', ') || '-', '| worst', worst, 'ms');
  // second open: number painted from memory before the network answers
  const t1 = Date.now();
  await p.goto(`http://localhost:${port}/leek-nook/`);
  const instant = await p.eval(`document.getElementById('mcNum').textContent`);
  console.log('second open shows', JSON.stringify(instant), 'at load event,', Date.now() - t1, 'ms');
  failed = worst > 200;
} finally { await b.close(); srv.close(); }
process.exit(failed ? 1 : 0);
