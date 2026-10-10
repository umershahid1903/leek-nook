// Tiny Chrome DevTools Protocol driver for the local tests (Node 24, no deps).
// Launches a throwaway headless Chrome with its own temp profile, so nothing
// touches the user's real browser or shows on their screen.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function launch({ port = 29000 + Math.floor(Math.random() * 900), args = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'leeknook-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--mute-audio', ...args, 'about:blank',
  ], { stdio: 'ignore' });

  let ver;
  for (let i = 0; i < 100; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!ver) throw new Error('chrome did not start');

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

  async function newPage(url = 'about:blank') {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const logs = [];
    listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') logs.push(`[${msg.params.type}] ` + msg.params.args.map(a => a.value ?? a.description).join(' '));
      if (msg.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      if (msg.method === 'Log.entryAdded') logs.push(`[log ${msg.params.entry.level}] ${msg.params.entry.text}`);
    });
    await s('Page.enable'); await s('Runtime.enable'); await s('Log.enable');
    const page = {
      sessionId, targetId, logs, send: s,
      async goto(u, waitMs = 0) {
        const loaded = new Promise(r => { const l = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.delete(l); r(); } }; listeners.add(l); });
        await s('Page.navigate', { url: u }); await loaded;
        if (waitMs) await new Promise(r => setTimeout(r, waitMs));
      },
      async eval(expr) {
        const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      async waitFor(expr, timeout = 15000) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) { try { if (await page.eval(expr)) return true; } catch {} await new Promise(r => setTimeout(r, 100)); }
        throw new Error('timeout waiting for: ' + expr);
      },
      async phone({ width = 412, height = 915, dpr = 2.625, dark = false } = {}) {
        await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: true });
        await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
      },
      async shot(file, opts = {}) {
        const { data } = await s('Page.captureScreenshot', { format: 'png', ...opts });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, Buffer.from(data, 'base64'));
      },
    };
    if (url !== 'about:blank') await page.goto(url);
    return page;
  }

  async function close() {
    try { await send('Browser.close'); } catch {}
    try { ws.close(); } catch {}
    await new Promise(r => setTimeout(r, 400));
    try { proc.kill(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  return { send, newPage, close, port, listeners };
}
