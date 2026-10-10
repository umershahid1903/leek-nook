// Live check of the deployed nook with the REAL keys: a throwaway headless
// Chrome hangs a bell on the github.io site, the real night watch (GitHub
// Actions) confirms it with a real push, then the bell is taken down again.
// Needs `gh` logged in. `node tests/live.e2e.mjs`
import { execFileSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import CONFIG from '../config.js';

const SITE = `https://${CONFIG.repo.split('/')[0]}.github.io/${CONFIG.repo.split('/')[1]}/`;
let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${what}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' }).trim();

async function runWatchOnGitHub() {
  const before = gh('run', 'list', '-R', CONFIG.repo, '--workflow', CONFIG.workflow, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId');
  gh('workflow', 'run', CONFIG.workflow, '-R', CONFIG.repo);
  let id = before;
  for (let i = 0; i < 30 && id === before; i++) { await sleep(3000); id = gh('run', 'list', '-R', CONFIG.repo, '--workflow', CONFIG.workflow, '--event', 'workflow_dispatch', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId'); }
  for (let i = 0; i < 60; i++) {
    const s = gh('run', 'view', id, '-R', CONFIG.repo, '--json', 'status,conclusion', '--jq', '.status + " " + .conclusion');
    if (s.startsWith('completed')) {
      const log = gh('run', 'view', id, '-R', CONFIG.repo, '--log').split('\n').filter((l) => /bells:|market cap|push failed|unreachable/.test(l)).map((l) => l.replace(/^.*?Z /, '')).join(' / ');
      return { ok: s === 'completed success', log };
    }
    await sleep(4000);
  }
  return { ok: false, log: 'timed out' };
}

const b = await launch();
try {
  await b.send('Browser.grantPermissions', { origin: new URL(SITE).origin, permissions: ['notifications'] });
  const p = await b.newPage();
  await p.phone();
  await p.goto(SITE);
  await p.waitFor(`document.getElementById('mcNum').textContent !== '…'`, 30000);
  ok(true, 'live site shows the market cap', await p.eval(`document.getElementById('mc').textContent`));
  await p.waitFor('navigator.serviceWorker.ready.then(() => true)', 20000);
  const { installabilityErrors } = await p.send('Page.getInstallabilityErrors');
  ok(installabilityErrors.length === 0, 'Chrome sees it as installable (home-screen app)', JSON.stringify(installabilityErrors));
  await p.eval(`window.__pushes = []; navigator.serviceWorker.addEventListener('message', (e) => window.__pushes.push(e.data))`);

  await sleep(1500);
  await p.eval(`document.getElementById('hangBtn').click()`);
  try { await p.waitFor(`JSON.parse(localStorage.getItem('ln.bell') || '{}').hung === true`, 30000); }
  catch (e) { console.log('btn:', await p.eval(`document.getElementById('hangBtn').textContent`), '| toast:', await p.eval(`document.getElementById('toast').textContent`), '| logs:', p.logs.join(' / ')); throw e; }
  ok(true, 'hung a bell on the live site (sealed note posted from github.io)');
  await sleep(2000);

  const run1 = await runWatchOnGitHub();
  ok(run1.ok && /confirmed 1/.test(run1.log), 'real night watch on GitHub opened the note and pushed', run1.log);
  try {
    await p.waitFor('window.__pushes.length >= 1', 60000);
    const status = await p.eval(`document.getElementById('bellStatus').textContent`);
    ok(/confirmed/.test(status), 'the push from GitHub reached the phone; page says confirmed', status);
    const titles = await p.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => ns.map((n) => n.title))`);
    ok(titles.includes('The bell is hung 🔔'), 'notification shown', JSON.stringify(titles));
  } catch { ok(false, 'no push arrived from the real night watch within 60 s'); }

  await p.eval(`document.getElementById('downBtn').click()`);
  await p.waitFor(`JSON.parse(localStorage.getItem('ln.bell') || '{}').hung === false`, 20000);
  await sleep(2000);
  const run2 = await runWatchOnGitHub();
  ok(run2.ok && /bells: 0 hung/.test(run2.log), 'taken down again; the real rack is empty', run2.log);
} catch (e) {
  ok(false, 'crashed: ' + e.message);
} finally { await b.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
