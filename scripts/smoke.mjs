import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const bs58enc = (buf) => {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let r = '';
  while (n > 0n) { r = ALPH[Number(n % 58n)] + r; n /= 58n; }
  let ld = 0;
  for (const b of buf) { if (b === 0) ld++; else break; }
  while (ld--) r = '1' + r;
  return r;
};

const PORT = process.env.SMOKE_PORT || '8811';
const env = {
  ...process.env,
  PORT,
  TURSO_DATABASE_URL: '',
  TURSO_AUTH_TOKEN: '',
  SOLANA_CLUSTER: 'mainnet',
  HELIUS_API_KEY: process.env.SMOKE_HELIUS ?? '',
  NODE_ENV: 'test',
};
const server = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
const base = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/status`);
      if (r.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

let readiness;
try { readiness = await waitReady(); } catch {}

describe('oclo-backend independent mode', () => {
  test('server starts in file-state mode', () => {
    assert.ok(readiness, 'server never became ready');
  });

  test('api/catalog works', async () => {
    const r = await fetch(`${base}/api/catalog`);
    assert.ok(r.ok, `catalog ${r.status}`);
    const j = await r.json();
    assert.ok(Array.isArray(j.data) && j.data.length > 0, 'catalog is empty');
  });

  test('quotes mutation works', async () => {
    const r = await fetch(`${base}/api/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ jobTypeId: 'image-classification', quantity: 2 }] }) });
    assert.ok(r.ok, `quotes ${r.status}`);
    const j = await r.json();
    assert.ok(typeof j.data?.totalUsd === 'number', 'quote total missing');
  });

  test('credits are protected without session', async () => {
    const r = await fetch(`${base}/api/credits`);
    assert.equal(r.status, 401);
  });


  test('valid wallet accepts a correct Ed25519 signature', async () => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const pub = bs58enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    const nonceR = await fetch(`${base}/api/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: pub }) });
    assert.equal(nonceR.status, 200);
    const nonce = await nonceR.json();
    const msgBytes = new TextEncoder().encode(nonce.data.message);
    const sig = await crypto.subtle.sign('Ed25519', kp.privateKey, msgBytes);
    const v = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: pub, nonce: nonce.data.nonce, signature: bs58enc(new Uint8Array(sig)) }) });
    assert.equal(v.status, 200);
    const j = await v.json();
    assert.equal(j.data.user.wallet, pub);
  });

  test('valid wallet rejects a bad signature', async () => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const pub = bs58enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    const nonceR = await fetch(`${base}/api/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: pub }) });
    const nonce = await nonceR.json();
    const bad = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: pub, nonce: nonce.data.nonce, signature: 'z'.repeat(88) }) });
    assert.equal(bad.status, 401);
  });
});

await new Promise((resolve) => {
  if (server.exitCode !== null) return resolve();
  server.once('exit', resolve);
  setTimeout(resolve, 10000);
});
