// /api/history?symbol=NVDA[&range=5y][&downsample=weekly]
// Primary: Stooq daily CSV (stable for 15+ yrs, no auth).
// Fallback: Yahoo v8/chart.
// Returns { symbol, source, t[], c[], v[] }.

const {
  fetchText,
  fetchJSON,
  ok,
  fail,
  cleanSymbol,
  safeGet,
  makeCache,
  makeTokenBucket,
  clientIp,
  isMobile,
} = require('./_lib');

const CACHE = makeCache(64);
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — daily bars don't change intraday
const allow = makeTokenBucket(60);

// Range to Stooq's `i=d` (daily) — Stooq returns full history; we trim client-side.
const RANGE_TO_DAYS = { '1y': 252, '2y': 504, '5y': 1260, '10y': 2520, max: 100000 };

exports.handler = async (event) => {
  if (!allow(clientIp(event))) return fail(429, 'rate_limited', { retryAfter: 60 });

  const qp = event.queryStringParameters || {};
  const symbol = cleanSymbol(qp.symbol || '');
  if (!symbol) return fail(400, 'bad_symbol');

  const range = RANGE_TO_DAYS[qp.range] ? qp.range : '5y';
  const targetDays = RANGE_TO_DAYS[range];

  // Default: downsample on mobile, full on desktop. ?downsample=weekly|none overrides.
  const dsParam = qp.downsample;
  const downsample =
    dsParam === 'weekly' ? 'weekly' : dsParam === 'none' ? 'none' : isMobile(event) ? 'weekly' : 'none';

  const cacheKey = `${symbol}|${range}|${downsample}`;
  const cached = CACHE.get(cacheKey);
  if (cached) return ok(cached, { sMaxAge: 3600, swr: 7200 });

  // Stooq primary.
  try {
    const stooqSym = symbol.includes('.') ? symbol.toLowerCase() : symbol.toLowerCase() + '.us';
    const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(stooqSym) + '&i=d';
    const r = await fetchText(url, { accept: 'text/csv', timeoutMs: 9000 });
    if (r.status >= 400) throw new Error('http_' + r.status);

    const lines = r.body.trim().split(/\r?\n/);
    if (lines.length < 2 || /no data/i.test(r.body)) throw new Error('empty_stooq');
    // Header: Date,Open,High,Low,Close,Volume
    const t = [];
    const c = [];
    const v = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const date = cols[0];
      const close = parseFloat(cols[4]);
      const vol = parseFloat(cols[5]);
      if (!date || !isFinite(close)) continue;
      t.push(date);
      c.push(close);
      v.push(isFinite(vol) ? vol : 0);
    }
    if (c.length === 0) throw new Error('parse_stooq');

    // Trim to requested range (most recent N).
    const startIdx = Math.max(0, c.length - targetDays);
    const payload = finalize(symbol, 'stooq', t.slice(startIdx), c.slice(startIdx), v.slice(startIdx), downsample);
    CACHE.set(cacheKey, payload, CACHE_TTL_MS);
    return ok(payload, { sMaxAge: 3600, swr: 7200 });
  } catch (e) {
    // fall through to Yahoo
  }

  // Yahoo fallback.
  try {
    const url =
      'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(symbol) +
      `?range=${encodeURIComponent(range)}&interval=1d&includeAdjustedClose=true`;
    const j = await fetchJSON(url, { timeoutMs: 9000 });
    const result = safeGet(j, 'chart.result.0', null);
    if (!result) throw new Error('empty_yahoo');

    const timestamps = safeGet(result, 'timestamp', []);
    const quote = safeGet(result, 'indicators.quote.0', {});
    const adj = safeGet(result, 'indicators.adjclose.0.adjclose', null);
    const closes = adj || quote.close || [];
    const volumes = quote.volume || [];

    const t = [];
    const c = [];
    const v = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (!isFinite(close)) continue;
      t.push(toISO(timestamps[i] * 1000));
      c.push(close);
      v.push(isFinite(volumes[i]) ? volumes[i] : 0);
    }
    if (c.length === 0) throw new Error('parse_yahoo');

    const payload = finalize(symbol, 'yahoo', t, c, v, downsample);
    CACHE.set(cacheKey, payload, CACHE_TTL_MS);
    return ok(payload, { sMaxAge: 3600, swr: 7200 });
  } catch (e2) {
    return fail(503, 'upstream_unavailable', { detail: String(e2.message || e2) });
  }
};

function finalize(symbol, source, t, c, v, downsample) {
  if (downsample === 'weekly' && c.length > 5) {
    const t2 = [];
    const c2 = [];
    const v2 = [];
    for (let i = c.length - 1; i >= 0; i -= 5) {
      t2.unshift(t[i]);
      c2.unshift(c[i]);
      v2.unshift(v[i]);
    }
    return { symbol, source, downsample: 'weekly', count: c2.length, t: t2, c: c2, v: v2 };
  }
  return { symbol, source, downsample: 'none', count: c.length, t, c, v };
}

function toISO(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}
