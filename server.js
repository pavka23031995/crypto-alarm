const http = require('http');

const PORT = Number(process.env.PORT || 10000);
const UPSTREAM = process.env.CRYPTO_ALARM_UPSTREAM || 'https://cripto-alarm-server.pavka2303.workers.dev';

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function copyRequestHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    const lower = name.toLowerCase();
    if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(lower)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  headers.set('x-forwarded-host', req.headers.host || '');
  headers.set('x-forwarded-proto', 'https');
  return headers;
}

function copyResponseHeaders(upstream, res) {
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(lower)) return;
    res.setHeader(name, value);
  });
  res.setHeader('x-crypto-alarm-proxy', 'render');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/__render-health') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      return res.end(JSON.stringify({
        ok: true,
        service: 'crypto-alarm-render-proxy',
        upstream: UPSTREAM,
        time: new Date().toISOString()
      }));
    }

    const target = new URL(req.url || '/', UPSTREAM);
    const method = (req.method || 'GET').toUpperCase();
    const body = ['GET', 'HEAD'].includes(method) ? undefined : await collectBody(req);

    const upstream = await fetch(target, {
      method,
      headers: copyRequestHeaders(req),
      body: body && body.length ? body : undefined,
      redirect: 'manual'
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    copyResponseHeaders(upstream, res);
    res.writeHead(upstream.status);
    res.end(responseBody);
  } catch (error) {
    console.error('Render proxy error:', error);
    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({
      ok: false,
      error: 'Render proxy could not reach Crypto Alarm backend',
      details: error?.message || String(error)
    }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crypto Alarm Render proxy listening on port ${PORT}`);
  console.log(`Upstream: ${UPSTREAM}`);
});
