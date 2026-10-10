// Draws the little leek and renders every icon with a throwaway headless Chrome.
// `node tools/make_icons.mjs` → icons/leek.svg + the PNGs the manifest lists.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../tests/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
mkdirSync(OUT, { recursive: true });

const IVORY = '#f0eee6';

// Same drawing as the buddy on the bar (index.html), with colors written in.
const leek = (ink = null) => {
  const f = (c) => ink || c;
  return `
  <g>
    <path fill="${f('#93ad72')}" d="M27 34C20 25 13 19 4 16C1 15 .2 18.6 3 19.8C11 23 18 29 23.5 37Z"/>
    <path fill="${f('#6a874c')}" d="M37 34C43 24 51 17 60 12.6C63 11.2 64.4 14.6 61.8 16.2C54 21 47.4 28 41 37Z"/>
    <path fill="${f('#7d9a5c')}" d="M27.5 33C26.4 21 28.6 9 32 -.6C33 -3.6 36.4 -3 35.8 0C34.6 10 35 21 36.6 33Z"/>
    ${ink ? '' : '<path d="M32 31C31.5 21 32.5 10 34.2 1.6" fill="none" stroke="rgba(52,72,33,.3)" stroke-width=".9" stroke-linecap="round"/>'}
    <rect x="19" y="26" width="26" height="44" rx="13" fill="${ink || 'url(#sg)'}" ${ink ? '' : 'stroke="rgba(90,110,60,.22)" stroke-width=".8"'}/>
    ${ink ? '' : `
    <path d="M27 69.5l-2 4.5M32 70v5M37 69.5l2 4.5" stroke="#b7a58c" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <rect x="16" y="39" width="32" height="9" rx="4.5" fill="#d97757"/>
    <g clip-path="url(#sc)" fill="#fbf1e8" opacity=".85"><rect x="23" y="39" width="2.4" height="9"/><rect x="30" y="39" width="2.4" height="9"/><rect x="37" y="39" width="2.4" height="9"/><rect x="44" y="39" width="2.4" height="9"/></g>
    <path fill="#d97757" d="M18.6 44.6L13.4 62.4Q13 64.8 15.4 65.2L18 65.6Q20 65.8 20.4 63.6L23.6 46Z"/>
    <rect x="16.5" y="40.5" width="8" height="7" rx="2.8" fill="#c6613f"/>
    <ellipse cx="24.5" cy="60" rx="2.9" ry="1.8" fill="#f2a08d" opacity=".85"/>
    <ellipse cx="40.5" cy="60" rx="2.9" ry="1.8" fill="#f2a08d" opacity=".85"/>
    <ellipse cx="27.6" cy="54.4" rx="1.9" ry="2.4" fill="#2b2a27"/><ellipse cx="37.4" cy="54.4" rx="1.9" ry="2.4" fill="#2b2a27"/>
    <circle cx="28.3" cy="53.5" r=".7" fill="#fff"/><circle cx="38.1" cy="53.5" r=".7" fill="#fff"/>
    <path d="M30 59.6Q32.5 62 35 59.6" fill="none" stroke="#2b2a27" stroke-width="1.5" stroke-linecap="round"/>`}
  </g>`;
};
const defs = `<defs>
  <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c5d6a2"/><stop offset=".38" stop-color="#ebefdc"/><stop offset=".62" stop-color="#fdfbf4"/><stop offset="1" stop-color="#fdfbf4"/></linearGradient>
  <clipPath id="sc"><rect x="16" y="39" width="32" height="9" rx="4.5"/></clipPath>
</defs>`;

// The leek's drawing spans x 0..64, y -3.6..75. Center it in a box.
const placed = (size, scale, dy = 0, ink) => {
  const s = (size * scale) / 80;
  const tx = size / 2 - 32 * s;
  const ty = size / 2 - 36 * s + dy * size;
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">${leek(ink)}</g>`;
};

const svgs = {
  // header mark + favicon: the leek alone
  'leek.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 76 84">${defs}${leek()}</svg>`,
  'icon-512': { size: 512, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<rect width="512" height="512" rx="116" fill="${IVORY}"/>${placed(512, .78, .01)}</svg>` },
  'icon-192': { size: 192, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">${defs}<rect width="192" height="192" rx="44" fill="${IVORY}"/>${placed(192, .78, .01)}</svg>` },
  'maskable-512': { size: 512, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<rect width="512" height="512" fill="${IVORY}"/>${placed(512, .6, .01)}</svg>` },
  'apple-touch-icon': { size: 180, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">${defs}<rect width="180" height="180" fill="${IVORY}"/>${placed(180, .74, .01)}</svg>` },
  // status-bar badge: Android only uses the alpha, so a plain white silhouette
  'badge-96': { size: 96, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">${placed(96, .9, 0, '#fff')}</svg>` },
};

writeFileSync(join(OUT, 'leek.svg'), svgs['leek.svg']);
const b = await launch();
try {
  const p = await b.newPage();
  await p.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const [name, { size, svg }] of Object.entries(svgs).filter(([k]) => !k.endsWith('.svg'))) {
    await p.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    await p.goto('data:text/html,' + encodeURIComponent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`));
    await p.shot(join(OUT, name + '.png'), { clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    console.log('icons/' + name + '.png');
  }
} finally { await b.close(); }
