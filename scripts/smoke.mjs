const base = process.env.BASE_URL || 'http://localhost:8787';
const endpoints = [
  '/status',
  '/api/config/public',
  '/api/catalog',
  '/api/batches',
  '/api/batches/B0003',
  '/api/results?batchId=B0003',
  '/api/ledger',
  '/api/buybacks',
  '/api/deposits/status',
  '/api/reserve/periods',
  '/api/reserve/holdings',
  '/api/quotes',
  '/api/inputs',
  '/api/auth/session',
];
let ok = true;
for (const e of endpoints) {
  try {
    const r = await fetch(base + e, { credentials: 'include' });
    const j = await r.json().catch(() => null);
    const pass = r.ok && j && j.ok !== false;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${e} -> ${r.status}`);
    if (!pass) ok = false;
  } catch (err) {
    console.log(`FAIL ${e} -> ${err.message}`);
    ok = false;
  }
}
// POST endpoints
const posts = [
  ['/api/auth/nonce', { wallet: '11111111111111111111111111111111' }],
  ['/api/quotes', { items: [{ jobTypeId: 'image-classification', quantity: 1 }], budgetUsd: 0.05 }],
  ['/api/inputs', { note: 'smoke' }],
  ['/api/provide/register', { wallet: '11111111111111111111111111111111', caps: {} }],
];
for (const [p, body] of posts) {
  try {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' });
    const j = await r.json().catch(() => null);
    const pass = r.ok && j && j.ok !== false;
    console.log(`${pass ? 'PASS' : 'FAIL'} POST ${p} -> ${r.status}`);
    if (!pass) ok = false;
  } catch (err) {
    console.log(`FAIL POST ${p} -> ${err.message}`);
    ok = false;
  }
}
// SSE
try {
  const r = await fetch(base + '/api/stream/runs?batchId=B0003', { credentials: 'include' });
  console.log(`${r.ok ? 'PASS' : 'FAIL'} SSE runs -> ${r.status}`);
  if (!r.ok) ok = false;
  // abort
  // read one chunk
  const reader = r.body.getReader();
  const { value } = await reader.read();
  console.log('SSE chunk bytes:', value ? value.length : 0);
  reader.cancel();
} catch (err) {
  console.log(`FAIL SSE -> ${err.message}`);
  ok = false;
}
console.log(ok ? '\\nALL SMOKE TESTS PASSED' : '\\nSMOKE TESTS FAILED');
process.exit(ok ? 0 : 1);