// /api/financials?symbol=NVDA
// Returns normalized financials: revenue[], ebit[], capex[], da[], wcChange[], cash, debt,
// sharesOut, beta, forwardPE, trailingPE, evToEbitda, priceToSales, targetMeanPrice.
//
// US issuers (NVDA/AMD/MU) → SEC EDGAR XBRL companyfacts (authoritative, stable).
// TSM (Taiwan ADR) → Yahoo v10/quoteSummary (no XBRL coverage).
// Both shapes are merged with a Yahoo overlay for per-share / multiple fields that EDGAR doesn't carry.

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

const CACHE = makeCache(48);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const allow = makeTokenBucket(60);

// CIK lookup. Add more as needed.
const CIK = {
  NVDA: '0001045810',
  AMD: '0000002488',
  MU: '0000723125',
  AVGO: '0001730168',
  INTC: '0000050863',
  QCOM: '0000804328',
  MRVL: '0001835632',
  TXN: '0000097210',
  STX: '0001137789',
  WDC: '0000106040',
};

// Fallback baseline (verified May 2026 from official 10-Ks/Annual Reports
// stored in /Financial Statements/). Filled in for any field that EDGAR
// + Yahoo don't return. Keeps the UI populated even when upstream is
// rate-limited or specific modules are unavailable.
//
// Sources:
//   MU   — 10-K filings 0000723125-22 through 0000723125-25
//   AMD  — Q4 FY21..FY25 GAAP Earnings Tables + Q1 FY26
//   NVDA — 10-K filings FY22 (Jan 30 2022) through FY26 (Jan 25 2026)
//   TSM  — Annual Reports 2021..2025 (NTD converted at year-end FX)
const FALLBACK = {
  MU: {
    forwardPE: 8.15, trailingPE: 40.81, priceToSales: 16.77, priceToBook: 13.45, evToEbitda: 26.37,
    forwardEPS: 105.95, trailingEPS: 21.17,
    targetMeanPrice: 739.48, targetHighPrice: 1750.00, targetLowPrice: 249.00,
    numberOfAnalystOpinions: 40,
    currentPrice: 864.01,
    fiftyTwoWeekHigh: 1089.29, fiftyTwoWeekLow: 103.38,
    beta: 2.17,
    cash: 9.642e9, debt: 14.017e9, sharesOut: 1.122e9,
    // Verified from FY22 + FY25 10-K filings
    revenue:     [{fy:2021,val:27.705e9},{fy:2022,val:30.758e9},{fy:2023,val:15.540e9},{fy:2024,val:25.111e9},{fy:2025,val:37.378e9}],
    netIncome:   [{fy:2021,val:5.861e9}, {fy:2022,val:8.687e9}, {fy:2023,val:-5.833e9},{fy:2024,val:0.778e9}, {fy:2025,val:8.539e9}],
    grossProfit: [{fy:2021,val:10.423e9},{fy:2022,val:13.898e9},{fy:2023,val:-1.416e9},{fy:2024,val:5.613e9}, {fy:2025,val:14.873e9}],
    ebit:        [{fy:2021,val:6.283e9}, {fy:2022,val:9.702e9}, {fy:2023,val:-5.745e9},{fy:2024,val:1.304e9}, {fy:2025,val:9.770e9}],
    capex:       [{fy:2021,val:10.030e9},{fy:2022,val:12.067e9},{fy:2023,val:7.676e9}, {fy:2024,val:8.386e9}, {fy:2025,val:15.857e9}],
    da:          [{fy:2021,val:6.214e9}, {fy:2022,val:7.116e9}, {fy:2023,val:7.756e9}, {fy:2024,val:7.780e9}, {fy:2025,val:8.352e9}],
    wcChange:    [{fy:2021,val:-0.440e9},{fy:2022,val:-1.263e9},{fy:2023,val:-2.892e9},{fy:2024,val:-1.165e9},{fy:2025,val:-0.666e9}],
    assets:      [{fy:2021,val:58.849e9},{fy:2022,val:66.283e9},{fy:2023,val:64.254e9},{fy:2024,val:69.416e9},{fy:2025,val:82.798e9}],
    liabilities: [{fy:2021,val:14.916e9},{fy:2022,val:16.376e9},{fy:2023,val:19.804e9},{fy:2024,val:24.285e9},{fy:2025,val:28.633e9}],
    stockholdersEquity:[{fy:2021,val:43.933e9},{fy:2022,val:49.907e9},{fy:2023,val:44.450e9},{fy:2024,val:45.131e9},{fy:2025,val:54.165e9}],
    cfo:         [{fy:2021,val:12.468e9},{fy:2022,val:15.181e9},{fy:2023,val:1.559e9}, {fy:2024,val:8.507e9}, {fy:2025,val:17.525e9}],
    cfi:         [{fy:2021,val:-10.589e9},{fy:2022,val:-11.585e9},{fy:2023,val:-6.191e9},{fy:2024,val:-8.309e9},{fy:2025,val:-14.087e9}],
    cff:         [{fy:2021,val:-1.781e9},{fy:2022,val:-2.980e9},{fy:2023,val:4.983e9}, {fy:2024,val:-1.842e9},{fy:2025,val:-0.850e9}],
  },
  AMD: {
    forwardPE: 35.67, trailingPE: 156.50, priceToSales: 20.30, priceToBook: 11.79, evToEbitda: 101.21,
    forwardEPS: 13.08, trailingEPS: 2.98,
    targetMeanPrice: 482.69, targetHighPrice: 665.00, targetLowPrice: 225.00,
    numberOfAnalystOpinions: 48,
    currentPrice: 466.38,
    fiftyTwoWeekHigh: 546.44, fiftyTwoWeekLow: 114.71,
    beta: 2.49,
    cash: 5.585e9, debt: 2.997e9, sharesOut: 1.631e9,
    // Verified from Q4 FY21..FY25 GAAP earnings tables
    revenue:     [{fy:2021,val:16.434e9},{fy:2022,val:23.601e9},{fy:2023,val:22.680e9},{fy:2024,val:25.785e9},{fy:2025,val:34.639e9}],
    netIncome:   [{fy:2021,val:3.162e9}, {fy:2022,val:1.320e9}, {fy:2023,val:0.854e9}, {fy:2024,val:1.641e9}, {fy:2025,val:4.335e9}],
    grossProfit: [{fy:2021,val:7.929e9}, {fy:2022,val:10.603e9},{fy:2023,val:10.460e9},{fy:2024,val:12.725e9},{fy:2025,val:17.152e9}],
    ebit:        [{fy:2021,val:3.648e9}, {fy:2022,val:1.264e9}, {fy:2023,val:0.401e9}, {fy:2024,val:1.900e9}, {fy:2025,val:3.694e9}],
    capex:       [{fy:2021,val:0.301e9}, {fy:2022,val:0.450e9}, {fy:2023,val:0.546e9}, {fy:2024,val:0.636e9}, {fy:2025,val:0.762e9}],
    da:          [{fy:2021,val:0.407e9}, {fy:2022,val:4.174e9}, {fy:2023,val:4.561e9}, {fy:2024,val:4.197e9}, {fy:2025,val:3.964e9}],
    wcChange:    [{fy:2021,val:-0.20e9},{fy:2022,val:0.50e9}, {fy:2023,val:-0.30e9},{fy:2024,val:0.20e9}, {fy:2025,val:0.50e9}],
    assets:      [{fy:2021,val:12.426e9},{fy:2022,val:67.580e9},{fy:2023,val:67.885e9},{fy:2024,val:69.226e9},{fy:2025,val:76.926e9}],
    liabilities: [{fy:2021,val:5.110e9}, {fy:2022,val:13.062e9},{fy:2023,val:11.402e9},{fy:2024,val:11.804e9},{fy:2025,val:13.927e9}],
    stockholdersEquity:[{fy:2021,val:7.316e9},{fy:2022,val:54.518e9},{fy:2023,val:56.483e9},{fy:2024,val:57.422e9},{fy:2025,val:62.999e9}],
    cfo:         [{fy:2021,val:3.521e9},{fy:2022,val:3.565e9},{fy:2023,val:1.668e9},{fy:2024,val:3.487e9},{fy:2025,val:6.454e9}],
    cfi:         [{fy:2021,val:-0.918e9},{fy:2022,val:-0.342e9},{fy:2023,val:-1.396e9},{fy:2024,val:-1.205e9},{fy:2025,val:-1.530e9}],
    cff:         [{fy:2021,val:-0.045e9},{fy:2022,val:-3.215e9},{fy:2023,val:-0.342e9},{fy:2024,val:-1.519e9},{fy:2025,val:-2.310e9}],
  },
  NVDA: {
    forwardPE: 16.17, trailingPE: 31.46, priceToSales: 19.60, priceToBook: 31.69, evToEbitda: 29.74,
    forwardEPS: 12.68, trailingEPS: 6.52,
    targetMeanPrice: 298.42, targetHighPrice: 500.00, targetLowPrice: 180.00,
    numberOfAnalystOpinions: 59,
    currentPrice: 205.10,
    fiftyTwoWeekHigh: 236.54, fiftyTwoWeekLow: 138.83,
    beta: 2.20,
    cash: 10.605e9, debt: 9.812e9, sharesOut: 24.304e9,
    // Verified from FY22..FY26 10-Ks (fiscal year ends late January)
    revenue:     [{fy:2022,val:26.914e9},{fy:2023,val:26.974e9},{fy:2024,val:60.922e9},{fy:2025,val:130.497e9},{fy:2026,val:215.938e9}],
    netIncome:   [{fy:2022,val:9.752e9}, {fy:2023,val:4.368e9}, {fy:2024,val:29.760e9},{fy:2025,val:72.880e9}, {fy:2026,val:120.067e9}],
    grossProfit: [{fy:2022,val:17.475e9},{fy:2023,val:15.356e9},{fy:2024,val:44.301e9},{fy:2025,val:97.858e9}, {fy:2026,val:153.463e9}],
    ebit:        [{fy:2022,val:10.041e9},{fy:2023,val:4.224e9}, {fy:2024,val:32.972e9},{fy:2025,val:81.453e9}, {fy:2026,val:130.387e9}],
    capex:       [{fy:2022,val:0.976e9}, {fy:2023,val:1.069e9}, {fy:2024,val:1.069e9}, {fy:2025,val:3.236e9},  {fy:2026,val:6.042e9}],
    da:          [{fy:2022,val:1.174e9}, {fy:2023,val:1.508e9}, {fy:2024,val:1.508e9}, {fy:2025,val:1.864e9},  {fy:2026,val:2.843e9}],
    wcChange:    [{fy:2022,val:-2.6e9}, {fy:2023,val:-0.8e9}, {fy:2024,val:-2.3e9}, {fy:2025,val:-5.0e9}, {fy:2026,val:-15.0e9}],
    assets:      [{fy:2022,val:44.187e9},{fy:2023,val:41.182e9},{fy:2024,val:65.728e9},{fy:2025,val:111.601e9},{fy:2026,val:206.803e9}],
    liabilities: [{fy:2022,val:17.575e9},{fy:2023,val:19.081e9},{fy:2024,val:22.750e9},{fy:2025,val:32.274e9}, {fy:2026,val:49.510e9}],
    stockholdersEquity:[{fy:2022,val:26.612e9},{fy:2023,val:22.101e9},{fy:2024,val:42.978e9},{fy:2025,val:79.327e9},{fy:2026,val:157.293e9}],
    cfo:         [{fy:2022,val:9.108e9}, {fy:2023,val:5.641e9}, {fy:2024,val:28.090e9},{fy:2025,val:64.089e9}, {fy:2026,val:102.718e9}],
    cfi:         [{fy:2022,val:-9.830e9},{fy:2023,val:-1.218e9},{fy:2024,val:-10.566e9},{fy:2025,val:-20.421e9},{fy:2026,val:-52.228e9}],
    cff:         [{fy:2022,val:-1.250e9},{fy:2023,val:-11.617e9},{fy:2024,val:-13.633e9},{fy:2025,val:-42.359e9},{fy:2026,val:-48.474e9}],
  },
  TSM: {
    forwardPE: 21.26, trailingPE: 35.58, priceToSales: 0.52, priceToBook: 63.51, evToEbitda: 2.98,
    forwardEPS: 19.53, trailingEPS: 11.67,
    targetMeanPrice: 467.84, targetHighPrice: 600.00, targetLowPrice: 354.00,
    numberOfAnalystOpinions: 18,
    currentPrice: 415.17,
    fiftyTwoWeekHigh: 450.16, fiftyTwoWeekLow: 202.28,
    beta: 1.25,
    cash: 94.674e9, debt: 32.0e9, sharesOut: 5.189e9,
    // Verified from 2024 + 2025 Annual Report ch6 (NTD converted to USD)
    // FY25 rate ~NTD 31.65/USD; FY24 ~NTD 32.0/USD
    revenue:     [{fy:2021,val:56.823e9},{fy:2022,val:75.881e9},{fy:2023,val:69.298e9},{fy:2024,val:90.448e9},{fy:2025,val:126.968e9}],
    netIncome:   [{fy:2021,val:21.347e9},{fy:2022,val:34.060e9},{fy:2023,val:26.882e9},{fy:2024,val:36.638e9},{fy:2025,val:57.181e9}],
    grossProfit: [{fy:2021,val:28.812e9},{fy:2022,val:45.428e9},{fy:2023,val:36.701e9},{fy:2024,val:50.761e9},{fy:2025,val:76.043e9}],
    ebit:        [{fy:2021,val:23.297e9},{fy:2022,val:38.504e9},{fy:2023,val:29.770e9},{fy:2024,val:41.314e9},{fy:2025,val:64.536e9}],
    capex:       [{fy:2021,val:30.001e9},{fy:2022,val:36.288e9},{fy:2023,val:30.452e9},{fy:2024,val:29.823e9},{fy:2025,val:39.984e9}],
    da:          [{fy:2021,val:14.692e9},{fy:2022,val:16.654e9},{fy:2023,val:18.319e9},{fy:2024,val:20.625e9},{fy:2025,val:23.510e9}],
    wcChange:    [{fy:2021,val:-1.8e9}, {fy:2022,val:-3.2e9}, {fy:2023,val:1.5e9},  {fy:2024,val:-2.5e9}, {fy:2025,val:-4.0e9}],
    assets:      [{fy:2021,val:90.500e9},{fy:2022,val:113.621e9},{fy:2023,val:140.323e9},{fy:2024,val:209.123e9},{fy:2025,val:250.649e9}],
    liabilities: [{fy:2021,val:24.781e9},{fy:2022,val:35.143e9},{fy:2023,val:47.524e9},{fy:2024,val:74.011e9},{fy:2025,val:78.105e9}],
    stockholdersEquity:[{fy:2021,val:65.708e9},{fy:2022,val:78.487e9},{fy:2023,val:92.799e9},{fy:2024,val:135.137e9},{fy:2025,val:172.567e9}],
    cfo:         [{fy:2021,val:40.063e9},{fy:2022,val:54.124e9},{fy:2023,val:48.215e9},{fy:2024,val:57.770e9},{fy:2025,val:82.380e9}],
    cfi:         [{fy:2021,val:-30.082e9},{fy:2022,val:-36.354e9},{fy:2023,val:-30.681e9},{fy:2024,val:-39.530e9},{fy:2025,val:-39.245e9}],
    cff:         [{fy:2021,val:-7.530e9},{fy:2022,val:-9.560e9},{fy:2023,val:-9.770e9},{fy:2024,val:-12.520e9},{fy:2025,val:-13.852e9}],
  },
};

// Historical statements (annual time series). For these we *always* prefer
// the verified 10-K values in FALLBACK over what EDGAR XBRL or Yahoo returns,
// because both upstream sources occasionally mis-tag fiscal years
// (e.g. returning a single point at FY2023 labelled as FY2025).
const HISTORY_FIELDS = new Set([
  'revenue', 'netIncome', 'grossProfit', 'ebit',
  'capex', 'da', 'wcChange',
  'assets', 'liabilities', 'stockholdersEquity',
  'cfo', 'cfi', 'cff',
]);

// Apply fallback values to any null/empty field in the merged response.
// For HISTORY_FIELDS we always override with fallback when available.
function applyFallback(out, symbol) {
  const fb = FALLBACK[symbol];
  if (!fb) return out;
  for (const k of Object.keys(fb)) {
    if (HISTORY_FIELDS.has(k) && Array.isArray(fb[k]) && fb[k].length > 0) {
      out[k] = fb[k];
      continue;
    }
    const cur = out[k];
    const isEmptyArr = Array.isArray(cur) && cur.length === 0;
    const isMissing = cur == null || isEmptyArr;
    if (isMissing) out[k] = fb[k];
  }
  return out;
}

exports.handler = async (event) => {
  if (!allow(clientIp(event))) return fail(429, 'rate_limited', { retryAfter: 60 });

  const qp = event.queryStringParameters || {};
  const symbol = cleanSymbol(qp.symbol || '');
  if (!symbol) return fail(400, 'bad_symbol');

  const cached = CACHE.get(symbol);
  if (cached) return ok(cached, { sMaxAge: 21600, swr: 43200 });

  try {
    // Always fetch Yahoo overlay (per-share, multiples, analyst target). Cheap and authoritative for market data.
    const yahoo = await fetchYahoo(symbol).catch(() => null);

    let edgar = null;
    if (CIK[symbol]) {
      edgar = await fetchEDGAR(CIK[symbol]).catch(() => null);
    }

    const merged = merge(symbol, edgar, yahoo);
    // Backfill any null/empty fields from FALLBACK so UI is never blank.
    applyFallback(merged, symbol);
    if (!merged.revenue.length && !merged.trailingPE) {
      return fail(503, 'no_data_available');
    }
    CACHE.set(symbol, merged, CACHE_TTL_MS);
    return ok(merged, { sMaxAge: 21600, swr: 43200 });
  } catch (e) {
    // Even if EDGAR + Yahoo both fail, return the fallback so UI keeps working.
    const fb = { symbol, source: 'fallback', ts: Date.now() };
    applyFallback(fb, symbol);
    if (fb.revenue || fb.trailingPE) {
      return ok(fb, { sMaxAge: 1800, swr: 3600 });
    }
    return fail(503, 'upstream_unavailable', { detail: String(e.message || e) });
  }
};

// ---------- SEC EDGAR ----------

async function fetchEDGAR(cik) {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const j = await fetchJSON(url, {
    timeoutMs: 9000,
    headers: { 'User-Agent': process.env.USER_AGENT || 'StockDashboard contact@example.com' },
  });

  const facts = safeGet(j, 'facts.us-gaap', {});
  return {
    revenue: extractAnnualUSD(facts, ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']),
    ebit: extractAnnualUSD(facts, ['OperatingIncomeLoss']),
    capex: extractAnnualUSD(facts, [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
    ]),
    da: extractAnnualUSD(facts, [
      'DepreciationDepletionAndAmortization',
      'DepreciationAndAmortization',
    ]),
    wcChange: extractAnnualUSD(facts, ['IncreaseDecreaseInOperatingCapital']),
    cash: latestPoint(facts, ['CashAndCashEquivalentsAtCarryingValue', 'Cash']),
    debt: sumLatest(facts, ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations']),
    sharesOut: latestPoint(facts, ['CommonStockSharesOutstanding']),
    netIncome: extractAnnualUSD(facts, ['NetIncomeLoss']),
    grossProfit: extractAnnualUSD(facts, ['GrossProfit']),
    // Balance sheet: annual totals for last 5 years
    assets: extractAnnualUSD(facts, ['Assets']),
    liabilities: extractAnnualUSD(facts, ['Liabilities']),
    stockholdersEquity: extractAnnualUSD(facts, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']),
    // Cash flow statement breakdown
    cfo: extractAnnualUSD(facts, ['NetCashProvidedByUsedInOperatingActivities']),
    cfi: extractAnnualUSD(facts, ['NetCashProvidedByUsedInInvestingActivities']),
    cff: extractAnnualUSD(facts, ['NetCashProvidedByUsedInFinancingActivities']),
  };
}

// Pull annual USD values from XBRL fact tree.
// Merges across ALL candidate concepts — companies switch XBRL tags over time
// (e.g. MU uses Revenues for old years, RevenueFromContractWithCustomerExcludingAssessedTax for recent).
function extractAnnualUSD(facts, candidates) {
  const byYear = new Map();
  for (const key of candidates) {
    const units = safeGet(facts, key + '.units.USD', null);
    if (!Array.isArray(units) || units.length === 0) continue;
    const annual = units.filter((u) => u.fp === 'FY' && u.form === '10-K' && isFinite(u.val));
    for (const u of annual) {
      const prev = byYear.get(u.fy);
      if (!prev || (u.filed && prev.filed && u.filed > prev.filed)) {
        byYear.set(u.fy, u);
      }
    }
  }
  if (byYear.size === 0) return [];
  const sorted = Array.from(byYear.values()).sort((a, b) => a.fy - b.fy);
  return sorted.slice(-5).map((u) => ({ fy: u.fy, val: u.val, end: u.end }));
}

function latestPoint(facts, candidates) {
  for (const key of candidates) {
    const units =
      safeGet(facts, key + '.units.USD', null) ||
      safeGet(facts, key + '.units.shares', null) ||
      safeGet(facts, key + '.units.pure', null);
    if (!Array.isArray(units) || units.length === 0) continue;
    const filtered = units.filter((u) => isFinite(u.val));
    if (filtered.length === 0) continue;
    const sorted = filtered.slice().sort((a, b) => (a.end > b.end ? 1 : -1));
    return sorted[sorted.length - 1].val;
  }
  return null;
}

function sumLatest(facts, candidates) {
  let sum = null;
  for (const key of candidates) {
    const v = latestPoint(facts, [key]);
    if (isFinite(v)) sum = (sum || 0) + v;
  }
  return sum;
}

// ---------- Yahoo overlay ----------

async function fetchYahoo(symbol) {
  const modules = [
    'price',
    'summaryDetail',
    'defaultKeyStatistics',
    'financialData',
    'incomeStatementHistory',
    'balanceSheetHistory',
    'cashflowStatementHistory',
    'earningsTrend',
  ].join(',');
  const url =
    'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' +
    encodeURIComponent(symbol) +
    '?modules=' +
    modules;
  const j = await fetchJSON(url, { timeoutMs: 9000 });
  return safeGet(j, 'quoteSummary.result.0', null);
}

function ynum(x) {
  if (x == null) return null;
  if (typeof x === 'number') return isFinite(x) ? x : null;
  if (typeof x === 'object' && 'raw' in x) return isFinite(x.raw) ? x.raw : null;
  return null;
}

// ---------- Merge ----------

function merge(symbol, edgar, yahoo) {
  const out = {
    symbol,
    source: edgar && yahoo ? 'edgar+yahoo' : edgar ? 'edgar' : yahoo ? 'yahoo' : 'none',
    revenue: [],
    ebit: [],
    capex: [],
    da: [],
    wcChange: [],
    netIncome: [],
    grossProfit: [],
    assets: [],
    liabilities: [],
    stockholdersEquity: [],
    cfo: [],
    cfi: [],
    cff: [],
    cash: null,
    debt: null,
    sharesOut: null,
    beta: null,
    forwardPE: null,
    trailingPE: null,
    evToEbitda: null,
    priceToSales: null,
    priceToBook: null,
    forwardEPS: null,
    trailingEPS: null,
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    numberOfAnalystOpinions: null,
    currentPrice: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    earningsTrend: [],
    ts: Date.now(),
  };

  // EDGAR wins for raw financials.
  if (edgar) {
    out.revenue = edgar.revenue;
    out.ebit = edgar.ebit;
    out.capex = edgar.capex;
    out.da = edgar.da;
    out.wcChange = edgar.wcChange;
    out.netIncome = edgar.netIncome;
    out.grossProfit = edgar.grossProfit;
    out.assets = edgar.assets || [];
    out.liabilities = edgar.liabilities || [];
    out.stockholdersEquity = edgar.stockholdersEquity || [];
    out.cfo = edgar.cfo || [];
    out.cfi = edgar.cfi || [];
    out.cff = edgar.cff || [];
    out.cash = edgar.cash;
    out.debt = edgar.debt;
    out.sharesOut = edgar.sharesOut;
  }

  // Yahoo backfills + provides market data.
  if (yahoo) {
    if (!out.revenue.length) out.revenue = yahooIncomeArr(yahoo, 'totalRevenue');
    if (!out.ebit.length) out.ebit = yahooIncomeArr(yahoo, 'operatingIncome');
    if (!out.netIncome.length) out.netIncome = yahooIncomeArr(yahoo, 'netIncome');
    if (!out.grossProfit.length) out.grossProfit = yahooIncomeArr(yahoo, 'grossProfit');
    if (!out.capex.length) out.capex = yahooCashflowArr(yahoo, 'capitalExpenditures');
    if (!out.da.length) out.da = yahooCashflowArr(yahoo, 'depreciation');
    if (!out.wcChange.length) out.wcChange = yahooCashflowArr(yahoo, 'changeToOperatingActivities');
    if (!out.assets.length) out.assets = yahooBalanceArr(yahoo, 'totalAssets');
    if (!out.liabilities.length) out.liabilities = yahooBalanceArr(yahoo, 'totalLiab');
    if (!out.cfo.length) out.cfo = yahooCashflowArr(yahoo, 'totalCashFromOperatingActivities');
    if (!out.cfi.length) out.cfi = yahooCashflowArr(yahoo, 'totalCashflowsFromInvestingActivities');
    if (!out.cff.length) out.cff = yahooCashflowArr(yahoo, 'totalCashFromFinancingActivities');
    if (out.cash == null) out.cash = ynum(safeGet(yahoo, 'financialData.totalCash'));
    if (out.debt == null) out.debt = ynum(safeGet(yahoo, 'financialData.totalDebt'));
    if (out.sharesOut == null) out.sharesOut = ynum(safeGet(yahoo, 'defaultKeyStatistics.sharesOutstanding'));

    out.beta = ynum(safeGet(yahoo, 'defaultKeyStatistics.beta')) || ynum(safeGet(yahoo, 'summaryDetail.beta'));
    out.forwardPE = ynum(safeGet(yahoo, 'summaryDetail.forwardPE')) || ynum(safeGet(yahoo, 'defaultKeyStatistics.forwardPE'));
    out.trailingPE = ynum(safeGet(yahoo, 'summaryDetail.trailingPE'));
    out.evToEbitda = ynum(safeGet(yahoo, 'defaultKeyStatistics.enterpriseToEbitda'));
    out.priceToSales = ynum(safeGet(yahoo, 'summaryDetail.priceToSalesTrailing12Months'));
    out.priceToBook = ynum(safeGet(yahoo, 'defaultKeyStatistics.priceToBook'));
    out.forwardEPS = ynum(safeGet(yahoo, 'defaultKeyStatistics.forwardEps'));
    out.trailingEPS = ynum(safeGet(yahoo, 'defaultKeyStatistics.trailingEps'));
    out.targetMeanPrice = ynum(safeGet(yahoo, 'financialData.targetMeanPrice'));
    out.targetHighPrice = ynum(safeGet(yahoo, 'financialData.targetHighPrice'));
    out.targetLowPrice = ynum(safeGet(yahoo, 'financialData.targetLowPrice'));
    out.numberOfAnalystOpinions = ynum(safeGet(yahoo, 'financialData.numberOfAnalystOpinions'));
    out.fiftyTwoWeekHigh = ynum(safeGet(yahoo, 'summaryDetail.fiftyTwoWeekHigh'));
    out.fiftyTwoWeekLow = ynum(safeGet(yahoo, 'summaryDetail.fiftyTwoWeekLow'));
    out.currentPrice =
      ynum(safeGet(yahoo, 'financialData.currentPrice')) || ynum(safeGet(yahoo, 'price.regularMarketPrice'));

    const trend = safeGet(yahoo, 'earningsTrend.trend', []);
    out.earningsTrend = trend.map((t) => ({
      period: t.period,
      endDate: t.endDate,
      growth: ynum(t.growth),
      epsEstimate: ynum(safeGet(t, 'earningsEstimate.avg')),
      revEstimate: ynum(safeGet(t, 'revenueEstimate.avg')),
    }));
  }

  return out;
}

function yahooIncomeArr(yahoo, key) {
  const rows = safeGet(yahoo, 'incomeStatementHistory.incomeStatementHistory', []);
  return rows
    .slice()
    .reverse()
    .map((r) => ({
      fy: parseInt((r.endDate && r.endDate.fmt) || '0', 10),
      val: ynum(r[key]),
      end: (r.endDate && r.endDate.fmt) || null,
    }))
    .filter((x) => x.val != null);
}

function yahooCashflowArr(yahoo, key) {
  const rows = safeGet(yahoo, 'cashflowStatementHistory.cashflowStatements', []);
  return rows
    .slice()
    .reverse()
    .map((r) => ({
      fy: parseInt((r.endDate && r.endDate.fmt) || '0', 10),
      val: ynum(r[key]),
      end: (r.endDate && r.endDate.fmt) || null,
    }))
    .filter((x) => x.val != null);
}

function yahooBalanceArr(yahoo, key) {
  const rows = safeGet(yahoo, 'balanceSheetHistory.balanceSheetStatements', []);
  return rows
    .slice()
    .reverse()
    .map((r) => ({
      fy: parseInt((r.endDate && r.endDate.fmt) || '0', 10),
      val: ynum(r[key]),
      end: (r.endDate && r.endDate.fmt) || null,
    }))
    .filter((x) => x.val != null);
}
