// One-time setup: makes the VAPID keys (web push) and the mailbox keys, writes
// the public halves into config.js and the private halves to .secrets/keys.json
// (git-ignored). `node tools/make_keys.mjs` refuses to overwrite existing keys
// unless --force, because phones that already hung a bell would go silent.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMailboxKeys } from '../mailbox.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = join(ROOT, '.secrets', 'keys.json');
if (existsSync(SECRETS) && !process.argv.includes('--force')) {
  console.error('keys already exist in .secrets/keys.json (use --force to replace them)');
  process.exit(1);
}

const webpush = createRequire(join(ROOT, 'bell', 'x.js'))('web-push');
const vapid = webpush.generateVAPIDKeys();
const mailbox = await makeMailboxKeys();
const topic = 'leeknook-' + Buffer.from(crypto.getRandomValues(new Uint8Array(15))).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x');

const cfgPath = join(ROOT, 'config.js');
let cfg = readFileSync(cfgPath, 'utf8');
cfg = cfg.replace(/vapidPublicKey: '[^']*'/, `vapidPublicKey: '${vapid.publicKey}'`)
  .replace(/mailboxPublicKey: '[^']*'/, `mailboxPublicKey: '${mailbox.publicKey}'`)
  .replace(/mailboxTopic: '[^']*'/, `mailboxTopic: '${topic}'`);
writeFileSync(cfgPath, cfg);

mkdirSync(dirname(SECRETS), { recursive: true });
writeFileSync(SECRETS, JSON.stringify({
  VAPID_PRIVATE_KEY: vapid.privateKey,
  MAILBOX_PRIVATE_JWK: JSON.stringify(mailbox.privateJwk),
  made: new Date().toISOString(),
}, null, 2));
console.log('config.js updated; private keys in .secrets/keys.json');
