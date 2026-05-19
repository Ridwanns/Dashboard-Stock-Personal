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
    if (!merged.revenue.length && !merged.trailingPE) {
      // Genuinely empty — both vendors failed.
      return fail(503, 'no_data_available');
    }
    CACHE.set(symbol, merged, CACHE_TTL_MS);
    return ok(merged, { sMaxAge: 21600, swr: 43200 });
  } catch (e) {
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
