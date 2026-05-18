// /api/peers?symbol=NVDA
// Returns peer comp rows for the comp chart.
// Uses a hardcoded curated peer map + Yahoo v7 quote in one batched call (cheap).

const {
  fetchJSON,
  ok,
  fail,
  cleanSymbol,
  safeGet,
  makeCache,
  makeTokenBucket,
  clientIp,
} = require('./_lib');

const CACHE = makeCache(16);
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const allow = makeTokenBucket(60);

const PEERS = {
  NVDA: ['AMD', 'AVGO', 'INTC', 'QCOM', 'MRVL'],
  AMD: ['NVDA', 'INTC', 'AVGO', 'QCOM', 'TXN'],
  MU: ['STX', 'WDC', 'INTC', 'AVGO'],
  TSM: ['UMC', 'ASML', 'AMAT', 'KLAC'],
};

exports.handler = async (event) => {
  if (!allow(clientIp(event))) return fail(429, 'rate_limited', { retryAfter: 60 });

  const qp = event.queryStringParameters || {};
  const symbol = cleanSymbol(qp.symbol || '');
  if (!symbol) return fail(400, 'bad_symbol');
  const peers = PEERS[symbol];
  if (!peers) return fail(400, 'unknown_symbol_peers');

  const cached = CACHE.get(symbol);
  if (cached) return ok(cached, { sMaxAge: 3600, swr: 7200 });

  const all = [symbol, ...peers];
  try {
    const url =
      'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
      encodeURIComponent(all.join(',')) +
      '&fields=' +
      encodeURIComponent(
        [
          'shortName',
          'longName',
          'regularMarketPrice',
          'marketCap',
          'trailingPE',
          'forwardPE',
          'priceToSalesTrailing12Months',
          'enterpriseToEbitda',
          'enterpriseValue',
          'epsTrailingTwelveMonths',
          'epsForward',
        ].join(',')
      );
    const j = await fetchJSON(url, { timeoutMs: 9000 });
    const results = safeGet(j, 'quoteResponse.result', []);
    if (!Array.isArray(results) || results.length === 0) throw new Error('empty');

    const rows = results.map((q) => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice ?? null,
      marketCap: q.marketCap ?? null,
      trailingPE: q.trailingPE ?? null,
      forwardPE: q.forwardPE ?? null,
      priceToSales: q.priceToSalesTrailing12Months ?? null,
      evToEbitda: q.enterpriseToEbitda ?? null,
      enterpriseValue: q.enterpriseValue ?? null,
      trailingEPS: q.epsTrailingTwelveMonths ?? null,
      forwardEPS: q.epsForward ?? null,
      isTarget: q.symbol === symbol,
    }));

    const payload = { target: symbol, count: rows.length, rows, ts: Date.now() };
    CACHE.set(symbol, payload, CACHE_TTL_MS);
    return ok(payload, { sMaxAge: 3600, swr: 7200 });
  } catch (e) {
    return fail(503, 'upstream_unavailable', { detail: String(e.message || e) });
  }
};
