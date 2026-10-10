// Phone-size screenshots of the nook, light and dark: `node tests/screens.mjs`
// Uses live market data; writes tests/out/*.png and prints console errors.
import { launch } from './cdp.mjs';
import { serve } from './serve.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const port = 18780 + Math.floor(Math.random() * 100);
const srv = await serve(port);
const b = await launch();
let bad = 0;
try {
  for (const dark of [false, true]) {
    const p = await b.newPage();
    await p.phone({ dark, width: Number(process.env.W || 412), height: Number(process.env.H || 915) });
    await p.goto(`http://localhost:${port}/leek-nook/`);
    await p.waitFor(`document.getElementById('mcNum').textContent !== '…'`, 20000);
    await new Promise((r) => setTimeout(r, Number(process.env.WAIT || 2200)));
    if (process.env.MOOD) await p.eval(`document.getElementById('buddy').className = 'buddy ${process.env.MOOD}'`);
    const name = (process.env.NAME || 'home') + (dark ? '-dark' : '-light');
    await p.shot(join(OUT, name + '.png'));
    if (process.env.FULL) {
      const h = await p.eval('document.documentElement.scrollHeight');
      await p.send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W || 412), height: h, deviceScaleFactor: 2.625, mobile: true });
      await new Promise((r) => setTimeout(r, 400));
      await p.shot(join(OUT, name + '-full.png'));
    }
    const errs = p.logs.filter((l) => /error|exception/i.test(l));
    if (errs.length) { bad++; console.log(name, 'CONSOLE:', errs.join('\n')); }
    console.log(name, 'ok', await p.eval(`document.getElementById('mc').textContent + ' | ' + document.getElementById('note').textContent + ' | ' + document.getElementById('moves').textContent`));
  }
} finally { await b.close(); srv.close(); }
process.exit(bad ? 1 : 0);
