const http = require('http');
const https = require('https');
const { URL } = require('url');

const UPSTREAM = process.env.NIBB_UPSTREAM || 'https://app.nibb.work';
const PORT = process.env.PORT || 8787;
const UP = new URL(UPSTREAM);

function proxy(req, res) {
  const upstreamPath = req.url; // keep path + query
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  headers.host = UP.hostname;

  const lib = UP.protocol === 'https:' ? https : http;
  const options = {
    hostname: UP.hostname,
    port: UP.port || (UP.protocol === 'https:' ? 443 : 80),
    path: upstreamPath,
    method: req.method,
    headers: headers,
  };

  const upstreamReq = lib.request(options, (upstreamRes) => {
    res.statusCode = upstreamRes.statusCode;
    Object.keys(upstreamRes.headers).forEach((k) => {
      if (k !== 'transfer-encoding') res.setHeader(k, upstreamRes.headers[k]);
    });
    // allow clone origin
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-requested-with');
    res.end();
    return;
  }
  if (req.url === '/status' || req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, service: 'nibb-backend-proxy' }));
    return;
  }
  proxy(req, res);
});

server.listen(PORT, () => {
  console.log(`nibb backend proxy listening on ${PORT}, upstream ${UPSTREAM}`);
});