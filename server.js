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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-crypto-alarm-proxy': 'render'
  });
  res.end(JSON.stringify(payload));
}

function requestedKlineLimit(period) {
  if (period === '1M') return 30;
  if (period === '6M') return 183;
  if (period === '1Y') return 365;
  return 120;
}

async function fetchBybitKlines(symbol, interval, limit) {
  const url = new URL('https://api.bybit.com/v5/market/kline');
  url.searchParams.set('category', 'spot');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(Math.max(20, Math.min(365, limit))));

  const response = await fetch(url, {
    headers: {
      'user-agent': 'CryptoAlarmRender/1.0',
      'accept': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`Bybit Kline HTTP ${response.status}`);
  const data = await response.json();
  if (data.retCode !== 0) throw new Error(`Bybit Kline: ${data.retMsg || data.retCode}`);

  const candles = (Array.isArray(data?.result?.list) ? data.result.list : [])
    .map(item => ({
      time: Number(item[0]),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5])
    }))
    .filter(item => Number.isFinite(item.time) && Number.isFinite(item.open) && Number.isFinite(item.high) && Number.isFinite(item.low) && Number.isFinite(item.close))
    .sort((a, b) => a.time - b.time);

  if (!candles.length) throw new Error(`Свечи ${symbol} не получены`);
  return candles;
}

async function fetchKrakenKlines(symbol, interval, limit) {
  const krakenInterval = interval === 'D' ? '1440' : interval;
  const url = new URL('https://api.kraken.com/0/public/OHLC');
  url.searchParams.set('pair', symbol);
  url.searchParams.set('interval', krakenInterval);

  const response = await fetch(url, {
    headers: {
      'user-agent': 'CryptoAlarmRender/1.0',
      'accept': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`Kraken OHLC HTTP ${response.status}`);
  const data = await response.json();
  if (Array.isArray(data?.error) && data.error.length) throw new Error(`Kraken OHLC: ${data.error.join(', ')}`);

  const result = data?.result || {};
  const seriesKey = Object.keys(result).find(key => key !== 'last');
  const rows = seriesKey ? result[seriesKey] : [];

  const candles = (Array.isArray(rows) ? rows : [])
    .slice(-Math.max(20, Math.min(365, limit)))
    .map(item => ({
      time: Number(item[0]) * 1000,
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[6])
    }))
    .filter(item => Number.isFinite(item.time) && Number.isFinite(item.open) && Number.isFinite(item.high) && Number.isFinite(item.low) && Number.isFinite(item.close))
    .sort((a, b) => a.time - b.time);

  if (!candles.length) throw new Error(`Свечи ${symbol} не получены через Kraken`);
  return candles;
}

async function handleRenderKlines(reqUrl, res) {
  const symbol = String(reqUrl.searchParams.get('symbol') || '').trim().toUpperCase();
  const interval = String(reqUrl.searchParams.get('interval') || '15').trim();
  const period = String(reqUrl.searchParams.get('period') || '').trim();

  if (!/^[A-Z0-9-]{3,30}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'Некорректная торговая пара' });
  if (!['15', '60', '240', 'D'].includes(interval)) return sendJson(res, 400, { ok: false, error: 'Недопустимый таймфрейм' });

  const limit = requestedKlineLimit(period);
  const errors = [];

  try {
    const candles = await fetchBybitKlines(symbol, interval, limit);
    return sendJson(res, 200, { ok: true, symbol, interval, period, candles, source: 'Bybit via Render' });
  } catch (error) {
    errors.push(error?.message || String(error));
  }

  try {
    const candles = await fetchKrakenKlines(symbol, interval, limit);
    return sendJson(res, 200, { ok: true, symbol, interval, period, candles, source: 'Kraken via Render', fallback: true });
  } catch (error) {
    errors.push(error?.message || String(error));
  }

  return sendJson(res, 502, { ok: false, error: `График недоступен. ${errors.join('; ')}` });
}

const server = http.createServer(async (req, res) => {
  try {
    const localUrl = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);

    if (localUrl.pathname === '/__render-health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'crypto-alarm-render-proxy',
        upstream: UPSTREAM,
        time: new Date().toISOString()
      });
    }

    // Public market data is fetched directly from Render so chart requests
    // do not inherit Cloudflare/Bybit 403 restrictions from the Worker.
    if ((req.method || 'GET').toUpperCase() === 'GET' && localUrl.pathname === '/api/klines') {
      return await handleRenderKlines(localUrl, res);
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
    sendJson(res, 502, {
      ok: false,
      error: 'Render proxy could not reach Crypto Alarm backend',
      details: error?.message || String(error)
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crypto Alarm Render proxy listening on port ${PORT}`);
  console.log(`Upstream: ${UPSTREAM}`);
});
