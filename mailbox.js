// The mailbox: how a phone hands its push address to the night watch.
// The phone seals a small note with the watch's public key (ECDH P-256 →
// HKDF-SHA256 → AES-256-GCM) and drops it at a public ntfy.sh topic; only the
// GitHub job holds the private key to open it. Same file runs in the browser
// and in Node 24 (both have WebCrypto, atob and btoa).
const subtle = globalThis.crypto.subtle;
const text = new TextEncoder();
const INFO = text.encode('leek-nook mailbox v1');
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

export const b64u = {
  enc(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

async function aesKey(privateKey, publicKey, salt, usage) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, hkdf, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export async function seal(note, mailboxPublicKey) {
  const theirs = await subtle.importKey('raw', b64u.dec(mailboxPublicKey), CURVE, false, []);
  const mine = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const eph = new Uint8Array(await subtle.exportKey('raw', mine.publicKey));
  const key = await aesKey(mine.privateKey, theirs, eph, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, text.encode(JSON.stringify(note)));
  return JSON.stringify({ v: 1, e: b64u.enc(eph), i: b64u.enc(iv), c: b64u.enc(ct) });
}

export async function open(sealed, mailboxPrivateJwk) {
  const env = typeof sealed === 'string' ? JSON.parse(sealed) : sealed;
  if (!env || env.v !== 1 || !env.e || !env.i || !env.c) throw new Error('not a mailbox note');
  const mine = await subtle.importKey('jwk', mailboxPrivateJwk, CURVE, false, ['deriveBits']);
  const eph = b64u.dec(env.e);
  const theirs = await subtle.importKey('raw', eph, CURVE, false, []);
  const key = await aesKey(mine, theirs, eph, 'decrypt');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(env.i) }, key, b64u.dec(env.c));
  return JSON.parse(new TextDecoder().decode(pt));
}

export async function makeMailboxKeys() {
  const kp = await subtle.generateKey(CURVE, true, ['deriveBits']);
  return {
    publicKey: b64u.enc(await subtle.exportKey('raw', kp.publicKey)),
    privateJwk: await subtle.exportKey('jwk', kp.privateKey),
  };
}
