// /api/technicals?symbols=NVDA,AMD,MU,TSM
// Fetches 1Y daily OHLCV data → calculates all technical indicators server-side.
// Returns per-symbol: MAs, RSI, MACD, Bollinger, Stochastic, CCI, Williams %R, ATR.

const {
  fetchText,
  fetchJSON,
  ok,
  fail,
  cleanSymbolList,
  safeGet,
  makeCache,
  makeTokenBucket,
  clientIp,
} = require('./_lib');

const CACHE = makeCache(16);
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — technicals don't need sub-minute refresh
const allow = makeTokenBucket(15);

const DEFAULT_SYMBOLS = ['MU', 'AMD', 'NVDA', 'TSM'];

// ── Indicator math ──

function sma(data, period) {
  if (data.length < period) return null;
  let sum = 0;
  for (let i = data.length - period; i < data.length; i++) sum += data[i];
  return sum / period;
}

function smaArray(data, period) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    out.push(sum / period);
  }
  return out;
}

function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let val = sma(data.slice(0, period), period);
  for (let i = period; i < data.length; i++) {
    val = data[i] * k + val * (1 - k);
  }
  return val;
}

function emaArray(data, period) {
  const out = [];
  const k = 2 / (period + 1);
  let val = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[j];
      val = sum / period;
      out.push(val);
      continue;
    }
    val = data[i] * k + val * (1 - k);
    out.push(val);
  }
  return out;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(closes) {
  const ema12 = emaArray(closes, 12);
  const ema26 = emaArray(closes, 26);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] == null || ema26[i] == null) { macdLine.push(null); continue; }
    macdLine.push(ema12[i] - ema26[i]);
  }
  const validMacd = macdLine.filter(v => v != null);
  const signal = validMacd.length >= 9 ? ema(validMacd, 9) : null;
  const macd = validMacd.length > 0 ? validMacd[validMacd.length - 1] : null;
  const histogram = (macd != null && signal != null) ? macd - signal : null;
  return { macd: r2(macd), signal: r2(signal), histogram: r2(histogram) };
}

function calcBollinger(closes, period, mult) {
  const mid = sma(closes, period);
  if (mid == null) return null;
  const slice = closes.slice(-period);
  let sumSq = 0;
  for (const v of slice) sumSq += (v - mid) * (v - mid);
  const std = Math.sqrt(sumSq / period);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const price = closes[closes.length - 1];
  const pctB = std > 0 ? (price - lower) / (upper - lower) : 0.5;
  const bandwidth = mid > 0 ? ((upper - lower) / mid) * 100 : 0;
  return {
    upper: r2(upper), middle: r2(mid), lower: r2(lower),
    pctB: r2(pctB), bandwidth: r2(bandwidth)
  };
}

function calcStochastic(highs, lows, closes, kPeriod, dPeriod) {
  if (closes.length < kPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const range = hh - ll;
    kValues.push(range > 0 ? ((closes[i] - ll) / range) * 100 : 50);
  }
  const k = kValues.length > 0 ? kValues[kValues.length - 1] : null;
  const d = kValues.length >= dPeriod ? sma(kValues.slice(-dPeriod), dPeriod) : null;
  return { k: r2(k), d: r2(d) };
}

function calcCCI(highs, lows, closes, period) {
  if (closes.length < period) return null;
  const tp = [];
  for (let i = 0; i < closes.length; i++) tp.push((highs[i] + lows[i] + closes[i]) / 3);
  const tpMean = sma(tp, period);
  if (tpMean == null) return null;
  const slice = tp.slice(-period);
  let madSum = 0;
  for (const v of slice) madSum += Math.abs(v - tpMean);
  const mad = madSum / period;
  return mad > 0 ? r2((tp[tp.length - 1] - tpMean) / (0.015 * mad)) : 0;
}

function calcWilliamsR(highs, lows, closes, period) {
  if (closes.length < period) return null;
  let hh = -Infinity, ll = Infinity;
  for (let i = closes.length - period; i < closes.length; i++) {
    if (highs[i] > hh) hh = highs[i];
    if (lows[i] < ll) ll = lows[i];
  }
  const range = hh - ll;
  return range > 0 ? r2(((hh - closes[closes.length - 1]) / range) * -100) : -50;
}

function calcATR(highs, lows, closes, period) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  let atr = sma(trs.slice(0, period), period);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return r2(atr);
}

function calcADX(highs, lows, closes, period) {
  if (closes.length < period * 2) return null;
  const pDM = [], nDM = [], tr = [];
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let sTR = sma(tr.slice(0, period), period);
  let sPDM = sma(pDM.slice(0, period), period);
  let sNDM = sma(nDM.slice(0, period), period);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    sTR = sTR - sTR / period + tr[i];
    sPDM = sPDM - sPDM / period + pDM[i];
    sNDM = sNDM - sNDM / period + nDM[i];
    const pDI = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const nDI = sTR > 0 ? (sNDM / sTR) * 100 : 0;
    const sum = pDI + nDI;
    dx.push(sum > 0 ? (Math.abs(pDI - nDI) / sum) * 100 : 0);
  }
  if (dx.length < period) return { adx: null, pDI: null, nDI: null };
  let adx = sma(dx.slice(0, period), period);
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  const lastPDI = sTR > 0 ? (sPDM / sTR) * 100 : 0;
  const lastNDI = sTR > 0 ? (sNDM / sTR) * 100 : 0;
  return { adx: r2(adx), pDI: r2(lastPDI), nDI: r2(lastNDI) };
}

function r2(v) { return v != null ? Math.round(v * 100) / 100 : null; }

// ── Data fetching (reuses Stooq/Yahoo like history.js but with OHLCV) ──

async function fetchOHLCV(symbol) {
  // Stooq primary
  try {
    const stooqSym = symbol.includes('.') ? symbol.toLowerCase() : symbol.toLowerCase() + '.us';
    const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(stooqSym) + '&i=d';
    const r = await fetchText(url, { accept: 'text/csv', timeoutMs: 9000 });
    if (r.status >= 400) throw new Error('http_' + r.status);
    const lines = r.body.trim().split(/\r?\n/);
    if (lines.length < 2 || /no data/i.test(r.body)) throw new Error('empty');
    const o = [], h = [], l = [], c = [], v = [], t = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const close = parseFloat(cols[4]);
      if (!isFinite(close)) continue;
      t.push(cols[0]);
      o.push(parseFloat(cols[1]) || close);
      h.push(parseFloat(cols[2]) || close);
      l.push(parseFloat(cols[3]) || close);
      c.push(close);
      v.push(parseFloat(cols[5]) || 0);
    }
    if (c.length < 50) throw new Error('insufficient_data');
    const start = Math.max(0, c.length - 252);
    return { t: t.slice(start), o: o.slice(start), h: h.slice(start), l: l.slice(start), c: c.slice(start), v: v.slice(start), source: 'stooq' };
  } catch (e) { /* fall through */ }

  // Yahoo fallback
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=1y&interval=1d&includeAdjustedClose=true';
  const j = await fetchJSON(url, { timeoutMs: 9000 });
  const result = safeGet(j, 'chart.result.0', null);
  if (!result) throw new Error('empty_yahoo');
  const timestamps = safeGet(result, 'timestamp', []);
  const quote = safeGet(result, 'indicators.quote.0', {});
  const adj = safeGet(result, 'indicators.adjclose.0.adjclose', null);
  const closes = adj || quote.close || [];
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const volumes = quote.volume || [];
  const t = [], o = [], h = [], l = [], c = [], v2 = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (!isFinite(closes[i])) continue;
    t.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
    o.push(opens[i] || closes[i]);
    h.push(highs[i] || closes[i]);
    l.push(lows[i] || closes[i]);
    c.push(closes[i]);
    v2.push(volumes[i] || 0);
  }
  if (c.length < 50) throw new Error('insufficient_data');
  return { t, o, h, l, c, v: v2, source: 'yahoo' };
}

function computeTechnicals(sym, data) {
  const { c, h, l, v } = data;
  const price = c[c.length - 1];
  const prevClose = c.length > 1 ? c[c.length - 2] : price;
  const change = r2(price - prevClose);
  const changePct = r2(prevClose > 0 ? (change / prevClose) * 100 : 0);

  // 52W high/low
  const high52w = Math.max(...h);
  const low52w = Math.min(...l);

  // Moving averages
  const mas = {};
  for (const p of [9, 10, 20, 50, 100, 200]) {
    mas['sma' + p] = r2(sma(c, p));
    mas['ema' + p] = r2(ema(c, p));
  }

  // Buy/Sell signal count
  let maBuy = 0, maSell = 0;
  for (const key of Object.keys(mas)) {
    if (mas[key] == null) continue;
    if (price > mas[key]) maBuy++; else maSell++;
  }

  // Oscillators
  const rsi = r2(calcRSI(c, 14));
  const macd = calcMACD(c);
  const bb = calcBollinger(c, 20, 2);
  const stoch = calcStochastic(h, l, c, 14, 3);
  const cci = calcCCI(h, l, c, 20);
  const willR = calcWilliamsR(h, l, c, 14);
  const atr = calcATR(h, l, c, 14);
  const adx = calcADX(h, l, c, 14);

  // Volume
  const avgVol30 = c.length >= 30 ? Math.round(sma(v.slice(-30), 30)) : null;
  const lastVol = v[v.length - 1];
  const relVol = avgVol30 > 0 ? r2(lastVol / avgVol30) : null;

  return {
    symbol: sym,
    source: data.source,
    date: data.t[data.t.length - 1],
    price: r2(price),
    change, changePct, prevClose: r2(prevClose),
    high52w: r2(high52w), low52w: r2(low52w),
    ma: { ...mas, buyCount: maBuy, sellCount: maSell },
    rsi, macd, bollinger: bb, stochastic: stoch, cci, williamsR: willR,
    atr, adx,
    volume: { last: lastVol, avg30d: avgVol30, relative: relVol }
  };
}

// ── Handler ──

exports.handler = async (event) => {
  if (!allow(clientIp(event))) return fail(429, 'rate_limited', { retryAfter: 60 });

  const raw = (event.queryStringParameters && event.queryStringParameters.symbols) || '';
  const symbols = raw ? cleanSymbolList(raw, 6) : DEFAULT_SYMBOLS.slice();
  if (symbols.length === 0) return fail(400, 'bad_symbols');

  const cacheKey = 'tech:' + symbols.join(',');
  const cached = CACHE.get(cacheKey);
  if (cached) return ok(cached, { sMaxAge: 300, swr: 600 });

  const results = {};
  const errors = [];

  await Promise.all(symbols.map(async (sym) => {
    try {
      const data = await fetchOHLCV(sym);
      results[sym] = computeTechnicals(sym, data);
    } catch (e) {
      errors.push({ symbol: sym, error: String(e.message || e) });
    }
  }));

  const payload = { ts: Date.now(), results, errors };
  if (Object.keys(results).length > 0) {
    CACHE.set(cacheKey, payload, CACHE_TTL_MS);
  }
  return ok(payload, { sMaxAge: 300, swr: 600 });
};
