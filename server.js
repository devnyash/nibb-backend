const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const PORT = process.env.PORT || 8787;
const CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const UPSTREAM_RPC = process.env.SOLANA_RPC_URL || (HELIUS_API_KEY
  ? `https://${CLUSTER}.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : (CLUSTER === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com'));
const DATA_DIR = path.join(__dirname, 'data');
const SEED_FILE = path.join(DATA_DIR, 'seed_upstream.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function base58Decode(str) {
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (typeof str !== 'string' || !str.length) throw new Error('bad sig');
  let num = 0n;
  for (const ch of str) {
    const idx = ALPH.indexOf(ch);
    if (idx === -1) throw new Error('bad base58');
    num = num * 58n + BigInt(idx);
  }
  let bytes = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  let leading = 0;
  for (const ch of str) { if (ch === '1') leading++; else break; }
  while (leading--) bytes.unshift(0);
  return new Uint8Array(bytes);
}
function base64Decode(str) {
  if (typeof str !== 'string') throw new Error('bad sig');
  return new Uint8Array(Buffer.from(str, 'base64'));
}
function decodeSignature(str) {
  if (typeof str !== 'string') throw new Error('bad sig');
  if (str.includes('/') || str.includes('+') || str.includes('=')) return base64Decode(str);
  return base58Decode(str);
}
async function verifyEd25519(wallet, msg, sig) {
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function dec(s){
    let n = 0n;
    for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad pub'); n = n * 58n + BigInt(i); }
    let b = [];
    while (n > 0n) { b.unshift(Number(n & 0xffn)); n >>= 8n; }
    let ld = 0;
    for (const c of s) { if (c === '1') ld++; else break; }
    while (ld--) b.unshift(0);
    return new Uint8Array(b);
  }
  const pub = dec(wallet);
  if (pub.length !== 32) throw new Error('bad publen');
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || (globalThis.crypto && globalThis.crypto.webcrypto && globalThis.crypto.webcrypto.subtle);
  if (!subtle) throw new Error('no subtle');
  const key = await subtle.importKey('raw', pub, 'Ed25519', false, ['verify']);
  return subtle.verify('Ed25519', key, new Uint8Array(sig), new Uint8Array(msg));
}
const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^libsql:\/\//, 'https://');
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let seed = {};
try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); } catch {}

function initialState() {
  return {
    config: (seed['config/public'] && seed['config/public'].data) || {},
    catalog: (seed['catalog'] && seed['catalog'].data) || [],
    batches: (seed['batches'] && seed['batches'].data) || [],
    results: (seed['results'] && seed['results'].data) || [],
    ledger: (seed['ledger'] && seed['ledger'].data) || [],
    buybacks: (seed['buybacks'] && seed['buybacks'].data) || {},
    deposits: (seed['deposits/status'] && seed['deposits/status'].data) || { batches:{open:true}, reserve:{open:true}, credits:{open:true} },
    holdings: (seed['reserve/holdings'] && seed['reserve/holdings'].data) || [],
    periods: (seed['reserve/periods'] && seed['reserve/periods'].data) || [],
    slots: [],
    quotes: [],
    inputs: [],
    devices: {},
    holdsByWallet: {},
    credits: {},
    sessions: {},
    nonces: {},
    jobsSeed: []
  };
}

async function tursoFetch(body) {
  const base = TURSO_URL.endsWith('/') ? TURSO_URL.slice(0,-1) : TURSO_URL;
  const url = base + '/v2/pipeline';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TURSO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: body })
  });
  return await resp.json();
}

async function tursoEnsure() {
  if (!TURSO_URL || !TURSO_TOKEN) return;
  await tursoFetch([{ type:'execute', stmt:{ sql:'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)', args: [] } }]);
}

function extractTursoValue(json) {
  for (const r of json.results || []) {
    const rows = (r.response && r.response.result && r.response.result.rows)
      || (r.result && r.result.rows)
      || r.rows;
    if (rows && rows.length) {
      const cell = rows[0][0];
      if (cell && typeof cell.value !== 'undefined') return cell.value;
      return cell;
    }
  }
  return null;
}

async function loadStateAsync() {
  if (TURSO_URL && TURSO_TOKEN) {
    try {
      await tursoEnsure();
      const json = await tursoFetch([{ type:'execute', stmt:{ sql:'SELECT v FROM kv WHERE k=?', args: [{'type':'text','value': 'state' }] } }]);
      const val = extractTursoValue(json);
      if (val) { try { return JSON.parse(val); } catch {} }
    } catch (e) { console.error('turso load failed', e.message); }
  } else {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  }
  return initialState();
}

let state = null;
let persistMode = (TURSO_URL && TURSO_TOKEN) ? 'turso' : 'file';
function persist() {
  if (!state) return;
  const data = JSON.stringify(state);
  if (persistMode === 'turso') {
    tursoFetch([{ type:'execute', stmt:{ sql:'INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', args: [{'type':'text','value':'state'},{'type':'text','value':data}] } }])
      .catch(e => console.error('turso persist failed', e.message));
  } else {
    try { fs.writeFileSync(STATE_FILE, data); } catch (e) { console.error('file persist failed', e.message); }
  }
}


// sessions
function cookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function newSession(wallet) {
  const id = 's_' + Math.random().toString(36).slice(2);
  state.sessions[id] = { wallet, createdAt: new Date().toISOString() };
  persist();
  return id;
}
function sessionUser(req) {
  const id = cookie(req, 'nbx_session');
  if (!id) return null;
  const s = state.sessions[id];
  return s ? { wallet: s.wallet } : null;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const b = Buffer.concat(chunks).toString();
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

function send(res, status, obj, extraHeaders={}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  Object.entries(extraHeaders).forEach(([k,v])=>res.setHeader(k,v));
  res.end(JSON.stringify(obj));
}

function parseUrl(url) {
  const i = url.indexOf('?');
  const path = i>=0 ? url.slice(0,i) : url;
  const query = i>=0 ? url.slice(i+1) : '';
  const params = new URLSearchParams(query);
  return { path, params };
}

const server = http.createServer(async (req,res) => {
  const { path, params } = parseUrl(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-origin','*');
    res.setHeader('access-control-allow-methods','GET,POST,PUT,DELETE,PATCH,OPTIONS');
    res.setHeader('access-control-allow-headers','content-type,authorization,cookie');
    res.end();
    return;
  }

  // health
  if (path === '/status' || path === '/health') {
    send(res,200,{ok:true,service:'nibb-backend',upstream:'local',ts:new Date().toISOString()});
    return;
  }
  if (path === '/' && !params.has('_rsc')) { send(res,200,{ok:true,message:'nibb backend'}); return; }

  // RPC proxy (Solana is external infra, not business data)
  if (path === '/api/rpc') {
    const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>{
      const body=Buffer.concat(chunks);
      const _rpcUrl=new URL(UPSTREAM_RPC);
      const r=https.request({hostname:_rpcUrl.hostname,path:_rpcUrl.pathname+_rpcUrl.search,method:'POST',headers:{'content-type':'application/json'}}, (resp)=>{
        res.statusCode=resp.statusCode; resp.pipe(res);
      });
      r.on('error', e=> send(res,502,{ok:false,error:e.message}));
      if (body.length) r.write(body);
      r.end();
    });
    return;
  }

  // auth
  if (path === '/api/auth/session' && req.method === 'GET') {
    const u = sessionUser(req);
    send(res,200,{ok:true,data:{user:u}});
    return;
  }
  if (path === "/api/auth/nonce" && req.method === "POST") {
    const b = await readBody(req);
    const wallet = b.wallet || params.get("wallet");
    const nonce = Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
    const domain = (function(){ try { if (req.headers.origin) return new URL(req.headers.origin).host; } catch (e) {} return req.headers.host || "localhost"; })();
    const issuedAt = new Date().toISOString();
    const message = `${domain} wants you to sign in with your Solana account:\n${wallet}\n\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
    state.nonces[nonce] = { wallet, message, createdAt: issuedAt };
    persist();
    send(res,200,{ok:true,data:{nonce,message}});
    return;
  }
  if (path === '/api/auth/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const wallet = b.wallet;
    const rec = state.nonces[b.nonce];
    if (!rec || rec.wallet !== wallet) {
      send(res,401,{ok:false,error:{code:'UNAUTHENTICATED',message:'Unverified'}}); return;
    }
    let ok = true;
    try {
      const msg = new TextEncoder().encode(rec.message);
      const sig = decodeSignature(b.signature);
      ok = await verifyEd25519(wallet, msg, sig);
    } catch (e) { ok = false; }
    if (!ok) {
      send(res,401,{ok:false,error:{code:'UNAUTHENTICATED',message:'Bad signature'}}); return;
    }
    delete state.nonces[b.nonce];
    const sid = newSession(wallet);
    res.setHeader('set-cookie', `nbx_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`);
    persist();
    send(res,200,{ok:true,data:{user:{wallet}}});
    return;
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const id = cookie(req,'nbx_session');
    if (id) delete state.sessions[id];
    persist();
    res.setHeader('set-cookie', 'nbx_session=; Path=/; Max-Age=0');
    send(res,200,{ok:true,data:{}});
    return;
  }

  // config
  if (path === '/api/config/public') { send(res,200,{ok:true,data:state.config}); return; }
  // catalog
  if (path === '/api/catalog') { send(res,200,{ok:true,data:state.catalog}); return; }
  // batches
  if (path === '/api/batches') { send(res,200,{ok:true,data:state.batches}); return; }
  let m = path.match(/^\/api\/batches\/(.+)$/);
  if (m) {
    const batch = state.batches.find(b=>b.id===decodeURIComponent(m[1]));
    send(res,200,{ok:true,data:batch||null});
    return;
  }
  // results
  if (path === '/api/results') {
    let data = state.results;
    const bid = params.get('batchId');
    if (bid) data = data.filter(r=>r.batchId===bid);
    send(res,200,{ok:true,data});
    return;
  }
  // ledger
  if (path === '/api/ledger') {
    send(res,200,{ok:true,data:state.ledger});
    return;
  }
  // buybacks
  if (path === '/api/buybacks') { send(res,200,{ok:true,data:state.buybacks}); return; }
  // deposits status
  if (path === '/api/deposits/status') {
    state.deposits.checkedAt = new Date().toISOString();
    send(res,200,{ok:true,data:state.deposits});
    return;
  }
  // reserve
  if (path === '/api/reserve/holdings') {
    const wallet = params.get('wallet');
    const data = wallet ? (state.holdings || []).filter(h=>h.wallet===wallet) : state.holdings;
    send(res,200,{ok:true,data});
    return;
  }
  if (path === '/api/reserve/periods') { send(res,200,{ok:true,data:state.periods}); return; }
  if (path === '/api/reserve/slots') {
    if (req.method === 'GET') { send(res,200,{ok:true,data:state.slots}); return; }
    if (req.method === 'POST') {
      const b = await readBody(req);
      const holding = { id:'hold-'+Date.now(), wallet:b.wallet||null, periodId:b.periodId||null, slotId:b.slotId||null, createdAt:new Date().toISOString(), status:'held' };
      state.slots.push(holding);
      if (b.wallet) {
        state.holdsByWallet[b.wallet] = state.holdsByWallet[b.wallet]||[];
        state.holdsByWallet[b.wallet].push(holding.id);
      }
      persist();
      send(res,200,{ok:true,data:holding});
      return;
    }
  }

  // credits
  if (path === '/api/credits') {
    const u = sessionUser(req);
    if (!u) { send(res,401,{ok:false,error:{code:'UNAUTHORIZED',message:'Sign in required'}}); return; }
    if (!state.credits[u.wallet]) state.credits[u.wallet] = { balanceUsd:0, lockedTokens:0, updatedAt:new Date().toISOString() };
    send(res,200,{ok:true,data:state.credits[u.wallet]});
    return;
  }

  // quotes
  if (path === '/api/quotes') {
    if (req.method === 'GET') { send(res,200,{ok:true,data:state.quotes}); return; }
    if (req.method === 'POST') {
      const b = await readBody(req);
      const items = (b.items||[]).map(it => {
        const jt = state.catalog.find(c=>c.id===it.jobTypeId);
        const price = jt ? (jt.pricePerJobUsd||0)*(it.quantity||0) : 0;
        return { jobTypeId: it.jobTypeId, quantity: it.quantity, priceUsd: price };
      });
      const total = items.reduce((a,x)=>a+x.priceUsd,0);
      const quote = { id:'Q-'+Date.now(), createdAt:new Date().toISOString(), items, totalUsd:total, budgetUsd: b.budgetUsd ?? total };
      state.quotes.push(quote);
      persist();
      send(res,200,{ok:true,data:quote});
      return;
    }
  }

  // inputs
  if (path === '/api/inputs') {
    if (req.method === 'GET') { send(res,200,{ok:true,data:state.inputs}); return; }
    if (req.method === 'POST') {
      const b = await readBody(req);
      const input = { id:'IN-'+Date.now(), createdAt:new Date().toISOString(), ...b };
      state.inputs.push(input);
      persist();
      send(res,200,{ok:true,data:input});
      return;
    }
  }

  // provide
  if (path === '/api/provide/register' && req.method === 'POST') {
    const b = await readBody(req);
    const device = { wallet:b.wallet||null, caps:b.caps||{}, registeredAt:new Date().toISOString(), status:'online' };
    const id = 'dev-'+Date.now();
    state.devices[id] = device;
    persist();
    send(res,200,{ok:true,data:{deviceId:id,...device}});
    return;
  }
  if (path === '/api/provide/claim' && req.method === 'POST') {
    const b = await readBody(req);
    // find an unclaimed job from batches/results? return a sample job
    const batch = state.batches[0];
    const job = { jobId: (batch?batch.id:'B0000') + '-' + (Math.floor(Math.random()*900)+100), batchId: batch?batch.id:null, imageId:'bird-02', claimedAt:new Date().toISOString(), device:b.deviceId||null };
    send(res,200,{ok:true,data:job});
    return;
  }
  if (path === '/api/provide/heartbeat' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.deviceId && state.devices[b.deviceId]) state.devices[b.deviceId].lastSeen=new Date().toISOString();
    persist();
    send(res,200,{ok:true,data:{ok:true}});
    return;
  }
  if (path === '/api/provide/leave' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.deviceId && state.devices[b.deviceId]) state.devices[b.deviceId].status='offline';
    persist();
    send(res,200,{ok:true,data:{ok:true}});
    return;
  }
  if (path === '/api/provide/submit' && req.method === 'POST') {
    const b = await readBody(req);
    const resRow = { jobId:b.jobId||('job-'+Date.now()), batchId:b.batchId||null, device:b.deviceId||null, status:'match', result:b.result||[], checkedBy:'operator', checkedAt:new Date().toISOString(), payoutTx:null };
    state.results.unshift(resRow);
    const ledgerRow = { id:'L-'+Date.now(), kind:'payout', jobId:resRow.jobId, batchId:resRow.batchId, device:resRow.device, check:'verified', amountUsd:b.amountUsd||0.044, status:'settled', tx:null, at:new Date().toISOString() };
    state.ledger.unshift(ledgerRow);
    persist();
    send(res,200,{ok:true,data:{job:resRow,ledger:ledgerRow}});
    return;
  }

  // SSE streams
  if (path === '/api/stream/runs') {
    res.statusCode=200;
    res.setHeader('content-type','text/event-stream');
    res.setHeader('cache-control','no-cache');
    res.setHeader('connection','keep-alive');
    res.write('retry: 3000\n\n');
    const bid = params.get('batchId');
    const hello = { batchId:bid, lastEventId:String(state.ledger.length+1) };
    res.write('event: hello\ndata: '+JSON.stringify(hello)+'\n\n');
    const interval = setInterval(()=> {
      if (res.writableEnded) { clearInterval(interval); return; }
      res.write('event: ping\ndata: '+JSON.stringify({ts:new Date().toISOString()})+'\n\n');
    }, 15000);
    req.on('close', ()=>clearInterval(interval));
    return;
  }
  if (path === '/api/stream/ledger') {
    res.statusCode=200;
    res.setHeader('content-type','text/event-stream');
    res.setHeader('cache-control','no-cache');
    res.setHeader('connection','keep-alive');
    res.write('retry: 3000\n\n');
    const hello = { lastEventId:String(state.ledger.length+1) };
    res.write('event: hello\ndata: '+JSON.stringify(hello)+'\n\n');
    const interval = setInterval(()=> {
      if (res.writableEnded) { clearInterval(interval); return; }
      res.write('event: ping\ndata: '+JSON.stringify({ts:new Date().toISOString()})+'\n\n');
    }, 15000);
    req.on('close', ()=>clearInterval(interval));
    return;
  }

  // RSC cache (autonomous, no upstream)
  if (params.has('_rsc') || req.headers.rsc === '1' || req.headers['next-router-prefetch'] !== undefined) {
    const clean = path.replace(/\/+$/, '');
    let name = 'index';
    if (clean && clean !== '' && clean !== '/' && clean !== '/app') {
      const parts = clean.split('/').filter(Boolean);
      name = parts[parts.length - 1];
    }
    const rscFile = (require('path')).join(__dirname, 'data', 'rsc', name + '.txt');
    if (fs.existsSync(rscFile)) {
      const buf = fs.readFileSync(rscFile);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'private, no-cache, no-store, max-age=0, must-revalidate');
      res.setHeader('x-nextjs-prerender', '1');
      res.end(buf);
      return;
    }
  }

  send(res,404,{ok:false,error:{code:'NOT_FOUND',message:'No route '+path}});
});

(async () => {
  state = await loadStateAsync();
  server.listen(PORT, () => {
    console.log('nibb backend (independent) listening on', PORT, 'persist=', persistMode);
  });
})();
