// /api/quotes?symbols=NVDA,AMD,MU,TSM
// Primary: Yahoo v7 quote.  Fallback: Stooq CSV.
// Hardened: symbol whitelist, schema validation, in-memory cache, token-bucket rate limit.

const {
  fetchJSON,
  fetchText,
  ok,
  fail,
  cleanSymbolList,
  safeGet,
  makeCache,
  makeTokenBucket,
  clientIp,
} = require('./_lib');

const CACHE = makeCache(32);
const CACHE_TTL_MS = 30_000; // 30s — quotes refresh faster than this in browser anyway
const allow = makeTokenBucket(30); // 30 req/min per IP

const DEFAULT_SYMBOLS = ['NVDA', 'AMD', 'MU', 'TSM'];

exports.handler = async (event) => {
  if (!allow(clientIp(event))) return fail(429, 'rate_limited', { retryAfter: 60 });

  const raw = (event.queryStringParameters && event.queryStringParameters.symbols) || '';
  const symbols = raw ? cleanSymbolList(raw, 12) : DEFAULT_SYMBOLS.slice();
  if (symbols.length === 0) return fail(400, 'bad_symbols');

  const cacheKey = symbols.join(',');
  const cached = CACHE.get(cacheKey);
  if (cached) return ok(cached, { sMaxAge: 30, swr: 90 });

  // Try Yahoo first.
  try {
    const url =
      'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
      encodeURIComponent(symbols.join(',')) +
      '&lang=en-US&region=US&corsDomain=finance.yahoo.com';
    const j = await fetchJSON(url, { timeoutMs: 8000 });

    const results = safeGet(j, 'quoteResponse.result', null);
    if (!Array.isArray(results) || results.length === 0) throw new Error('empty_yahoo');

    const normalized = results.map((q) => ({
      symbol: q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      prevClose: q.regularMarketPreviousClose,
      open: q.regularMarketOpen,
      dayHigh: q.regularMarketDayHigh,
      dayLow: q.regularMarketDayLow,
      volume: q.regularMarketVolume,
      marketCap: q.marketCap,
      currency: q.currency,
      shortName: q.shortName,
      longName: q.longName,
      exchange: q.fullExchangeName,
      source: 'yahoo',
      ts: Date.now(),
    }));
    const payload = { source: 'yahoo', quotes: normalized };
    CACHE.set(cacheKey, payload, CACHE_TTL_MS);
    return ok(payload, { sMaxAge: 30, swr: 90 });
  } catch (e) {
    // Fall through to Stooq.
  }

  // Stooq fallback — one CSV row per symbol.
  // Stooq US tickers need a `.us` suffix (e.g., nvda.us). Indices (^GSPC) aren't supported.
  try {
    const queries = symbols
      .filter((s) => !s.startsWith('^'))
      .map((s) => s.toLowerCase() + '.us')
      .join(',');
    if (!queries) throw new Error('no_stooq_symbols');

    const url =
      'https://stooq.com/q/l/?s=' +
      encodeURIComponent(queries) +
      '&f=sd2t2ohlcv&h&e=csv';
    const r = await fetchText(url, { accept: 'text/csv', timeoutMs: 8000 });
    if (r.status >= 400) throw new Error('http_' + r.status);

    // Parse CSV. Header: Symbol,Date,Time,Open,High,Low,Close,Volume
    const lines = r.body.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('empty_stooq');
    const normalized = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const sym = (cols[0] || '').toUpperCase().replace(/\.US$/, '');
      const close = parseFloat(cols[6]);
      const open = parseFloat(cols[3]);
      if (!sym || !isFinite(close)) continue;
      normalized.push({
        symbol: sym,
        price: close,
        change: isFinite(open) ? close - open : null,
        changePct: isFinite(open) && open !== 0 ? ((close - open) / open) * 100 : null,
        prevClose: null,
        open: isFinite(open) ? open : null,
        dayHigh: parseFloat(cols[4]) || null,
        dayLow: parseFloat(cols[5]) || null,
        volume: parseInt(cols[7], 10) || null,
        marketCap: null,
        currency: 'USD',
        shortName: sym,
        longName: sym,
        exchange: 'STOOQ',
        source: 'stooq',
        ts: Date.now(),
      });
    }
    if (normalized.length === 0) throw new Error('parse_stooq');
    const payload = { source: 'stooq', quotes: normalized };
    CACHE.set(cacheKey, payload, CACHE_TTL_MS);
    return ok(payload, { sMaxAge: 30, swr: 90 });
  } catch (e2) {
    return fail(503, 'upstream_unavailable', { detail: String(e2.message || e2) });
  }
};
