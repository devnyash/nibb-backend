const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 8787;
const UPSTREAM_RPC = 'https://api.mainnet-beta.solana.com';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'nibb.sqlite');
const SEED_FILE = path.join(DATA_DIR, 'seed_upstream.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let seed = {};
try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); } catch {}

const db = new DatabaseSync(DB_FILE);
db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
const getKv = db.prepare('SELECT v FROM kv WHERE k=?');
const setKv = db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)');

function loadState() {
  const row = getKv.get('state');
  if (row) { try { return JSON.parse(row.v); } catch {} }
  // initial
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
let state = loadState();
function persist() { setKv.run('state', JSON.stringify(state)); }

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
  if (path === '/') { send(res,200,{ok:true,message:'nibb backend'}); return; }

  // RPC proxy (Solana is external infra, not business data)
  if (path === '/api/rpc') {
    const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>{
      const body=Buffer.concat(chunks);
      const r=https.request({hostname:'api.mainnet-beta.solana.com',path:'/',method:'POST',headers:{'content-type':'application/json'}}, (resp)=>{
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
  if (path === '/api/auth/nonce' && req.method === 'POST') {
    const b = await readBody(req);
    const wallet = b.wallet || params.get('wallet');
    const nonce = Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
    state.nonces[wallet] = nonce;
    const message = `nibb.work wants you to sign in with your Solana account:\n${wallet}\n\nNonce: ${nonce}`;
    persist();
    send(res,200,{ok:true,data:{nonce,message,wallet}});
    return;
  }
  if (path === '/api/auth/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const wallet = b.wallet;
    state.nonces[wallet] = null;
    const sid = newSession(wallet);
    res.setHeader('set-cookie', `nbx_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`);
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

  // fallback 404
  send(res,404,{ok:false,error:{code:'NOT_FOUND',message:'No route '+path}});
});

server.listen(PORT, () => {
  console.log('nibb backend (independent) listening on', PORT);
});
