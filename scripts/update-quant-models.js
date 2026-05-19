#!/usr/bin/env node
// update-quant-models.js
// Fetches latest financial data and recalculates quant model + technical FALLBACK values in index.html.
// Run via: node scripts/update-quant-models.js
// Or via GitHub Actions cron (see .github/workflows/update-models.yml)

const https = require('https');
const fs = require('fs');
const path = require('path');

const SYMBOLS = ['MU', 'AMD', 'NVDA', 'TSM'];
const HTML_FILE = path.join(__dirname, '..', 'index.html');
const SECONDARY_FILE = path.resolve(__dirname, '..', '..', 'stock-dashboard-new.html');

// Beta values (5Y monthly, updated periodically)
const BETA_MAP = { MU: 1.96, AMD: 2.41, NVDA: 2.25, TSM: 1.40 };
const VOL_MAP = { MU: 0.58, AMD: 0.52, NVDA: 0.55, TSM: 0.42 };

// ── HTTP helpers ──

function fetchText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/csv,application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    }, opts.headers || {});
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

// ── Fetch history with multi-source fallback ──

async function fetchHistoryYahoo(symbol) {
  // Yahoo v8 chart API – works server-side; returns ~1Y of daily OHLCV
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`;
  const txt = await fetchText(url);
  const json = JSON.parse(txt);
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error('Yahoo: empty response');
  const ts = result.timestamp || [];
  const ind = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!ind) throw new Error('Yahoo: missing quote data');
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = ind.open[i], h = ind.high[i], l = ind.low[i], c = ind.close[i], v = ind.volume[i];
    if (c == null || isNaN(c) || c <= 0) continue;
    out.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: +o, high: +h, low: +l, close: +c,
      volume: parseInt(v, 10) || 0,
    });
  }
  return out;
}

async function fetchHistoryStooq(symbol) {
  // Explicit 2-year date range for Stooq (handles GH Actions geo restrictions)
  const today = new Date();
  const past = new Date(today.getTime() - 730 * 86400e3);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&d1=${fmt(past)}&d2=${fmt(today)}&i=d`;
  const csv = await fetchText(url);
  if (!csv || csv.length < 50 || csv.toLowerCase().includes('no data')) {
    throw new Error('Stooq: empty CSV');
  }
  const lines = csv.trim().split(/\r?\n/).slice(1);
  return lines.map(line => {
    const [date, open, high, low, close, volume] = line.split(',');
    return {
      date,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseInt(volume, 10) || 0,
    };
  }).filter(d => !isNaN(d.close) && d.close > 0);
}

async function fetchHistory(symbol) {
  let history = [];
  let lastErr = null;
  // Try Yahoo first (more reliable on GitHub Actions)
  try {
    history = await fetchHistoryYahoo(symbol);
    if (history.length >= 60) return history;
    lastErr = new Error(`Yahoo returned only ${history.length} rows`);
  } catch (e) { lastErr = e; }

  // Fallback to Stooq
  try {
    history = await fetchHistoryStooq(symbol);
    if (history.length >= 60) return history;
    lastErr = new Error(`Stooq returned only ${history.length} rows`);
  } catch (e) { lastErr = e; }

  throw new Error(`history fetch failed: ${lastErr ? lastErr.message : 'unknown'}`);
}

// ── Technical calculations ──

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function calcIchimoku(history) {
  const n = history.length;
  const t9 = history.slice(-Math.min(9, n));
  const tenkan = (Math.max(...t9.map(d => d.high)) + Math.min(...t9.map(d => d.low))) / 2;
  const k26 = history.slice(-Math.min(26, n));
  const kijun = (Math.max(...k26.map(d => d.high)) + Math.min(...k26.map(d => d.low))) / 2;
  const spanA = (tenkan + kijun) / 2;
  const b52 = history.slice(-Math.min(52, n));
  const spanB = (Math.max(...b52.map(d => d.high)) + Math.min(...b52.map(d => d.low))) / 2;
  const chikou = history[n - 1].close;
  return { tenkan, kijun, spanA, spanB, chikou };
}

function calcFibonacci(history) {
  // Use up to last 252 days (1Y) — falls back gracefully if less is available
  const yr = history.slice(-Math.min(252, history.length));
  const high = Math.max(...yr.map(d => d.high));
  const low = Math.min(...yr.map(d => d.low));
  const range = high - low;
  return {
    high,
    low,
    fib0: high,
    fib236: high - range * 0.236,
    fib382: high - range * 0.382,
    fib50: high - range * 0.50,
    fib618: high - range * 0.618,
    fib786: high - range * 0.786,
    fib100: low,
    ext1272: high + range * 0.272,
    ext1618: high + range * 0.618,
    ext2000: high + range * 1.000,
  };
}

function calcPivots(lastDay) {
  const { high, low, close } = lastDay;
  const p = (high + low + close) / 3;
  return {
    pivot: p,
    r1: 2 * p - low,
    r2: p + (high - low),
    r3: 2 * p + (high - 2 * low),
    s1: 2 * p - high,
    s2: p - (high - low),
    s3: 2 * p - (2 * high - low),
  };
}

function calcVWAP(history, periodDays) {
  const slice = history.slice(-periodDays);
  let cumPV = 0, cumV = 0;
  for (const d of slice) {
    const tp = (d.high + d.low + d.close) / 3;
    cumPV += tp * d.volume;
    cumV += d.volume;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

function calcAvgVolume(history, periodDays) {
  const slice = history.slice(-periodDays);
  return slice.reduce((a, b) => a + b.volume, 0) / slice.length;
}

// ── Monte Carlo simulation ──

function monteCarlo(currentPrice, annualVol, simulations, days) {
  const dailyVol = annualVol / Math.sqrt(252);
  const dailyDrift = 0.0002;
  const results = [];
  for (let s = 0; s < simulations; s++) {
    let price = currentPrice;
    for (let d = 0; d < days; d++) {
      const z = gaussianRandom();
      price *= Math.exp(dailyDrift - 0.5 * dailyVol * dailyVol + dailyVol * z);
    }
    results.push(price);
  }
  results.sort((a, b) => a - b);
  const p = (pct) => Math.round(results[Math.floor(pct * results.length)]);
  const mean = Math.round(results.reduce((a, b) => a + b, 0) / results.length);
  return [p(0.05), p(0.25), p(0.50), p(0.75), p(0.95), mean, Math.round(currentPrice)];
}

function gaussianRandom() {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function calcRiskMetrics(quote) {
  const beta = quote.beta || 1.2;
  const vol = beta * 30;
  const sharpe = (0.15 / (vol / 100)).toFixed(2);
  const sortino = (sharpe * 1.45).toFixed(2);
  const maxDD = (-vol * 0.65).toFixed(1);
  const var95 = (-vol * 0.08).toFixed(1);
  return [
    { label: 'Sharpe', display: sharpe, normalized: Math.min(sharpe / 3, 1).toFixed(2) },
    { label: 'Sortino', display: sortino, normalized: Math.min(sortino / 4, 1).toFixed(2) },
    { label: 'Beta', display: beta.toFixed(2), normalized: (beta / 2.5).toFixed(2) },
    { label: 'Volatility', display: vol.toFixed(1) + '%', normalized: (vol / 80).toFixed(2) },
    { label: 'Max DD', display: maxDD + '%', normalized: (Math.abs(parseFloat(maxDD)) / 60).toFixed(2) },
    { label: 'VaR 95%', display: var95 + '%', normalized: (Math.abs(parseFloat(var95)) / 8).toFixed(2) },
  ];
}

// ── HTML update helpers ──

// Replace the Nth dollar value inside a section keyed by a unique anchor
function replaceInSection(html, sectionAnchor, sectionEnd, replacements) {
  const startIdx = html.indexOf(sectionAnchor);
  if (startIdx < 0) return html;
  const endIdx = html.indexOf(sectionEnd, startIdx);
  if (endIdx < 0) return html;
  let block = html.substring(startIdx, endIdx);
  for (const r of replacements) {
    block = block.replace(r.find, r.replace);
  }
  return html.substring(0, startIdx) + block + html.substring(endIdx);
}

const fmt$ = (v, dp = 2) => '$' + Number(v).toFixed(dp);
const fmt$0 = (v) => '$' + Math.round(v).toFixed(0);
const fmtN = (v, dp = 2) => Number(v).toFixed(dp);

// ── Per-stock HTML updates ──

function updateTechnicalSection(html, symbol, quote, technical) {
  const ich = technical.ichimoku;
  const fib = technical.fibonacci;
  const piv = technical.pivots;

  // Build search anchors by symbol section header
  // The pattern uses the unique "Technical Analysis for SYMBOL" or the technical section IDs
  const techSecStart = `id="${symbol.toLowerCase()}-technical"`;
  const techSecEnd = `id="${symbol.toLowerCase()}-fundamental"`;

  const startIdx = html.indexOf(techSecStart);
  if (startIdx < 0) return html;
  const endIdx = html.indexOf(techSecEnd, startIdx);
  if (endIdx < 0) return html;
  let block = html.substring(startIdx, endIdx);

  // 1. Update Ichimoku values (table row pattern)
  block = block.replace(
    /(<tr><td>Tenkan-sen \(9\)<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(ich.tenkan)}`
  );
  block = block.replace(
    /(<tr><td>Kijun-sen \(26\)<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(ich.kijun)}`
  );
  block = block.replace(
    /(<tr><td>Senkou Span A<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(ich.spanA)}`
  );
  block = block.replace(
    /(<tr><td>Senkou Span B<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(ich.spanB)}`
  );
  block = block.replace(
    /(<tr><td>Chikou Span<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(ich.chikou)}`
  );

  // 2. Update Fibonacci levels
  block = block.replace(
    /(<tr><td>0% \(ATH\)<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.fib0)}`
  );
  block = block.replace(
    /(<tr><td>23\.6%<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.fib236)}`
  );
  block = block.replace(
    /(<tr><td>38\.2%<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.fib382)}`
  );
  block = block.replace(
    /(<tr><td>50%<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.fib50)}`
  );
  block = block.replace(
    /(<tr><td>61\.8% \(Golden Ratio\)<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.fib618)}`
  );
  block = block.replace(
    /(<tr><td>78\.6%<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.fib786)}`
  );
  block = block.replace(
    /(<tr><td>100% \(Low\)<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.fib100)}`
  );
  block = block.replace(
    /(<tr><td>127\.2%<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.ext1272)}`
  );
  block = block.replace(
    /(<tr><td>161\.8%<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.ext1618)}`
  );
  block = block.replace(
    /(<tr><td>200%<\/td><td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(fib.ext2000)}`
  );

  // 3. Update Pivot S&R levels
  block = block.replace(
    /(<td>Support 1 \(Pivot S1\)<\/td>\s*<td[^>]*>)\$[\d.,]+/,
    `$1${fmt$(piv.s1)}`
  );

  // 4. Update VWAP values
  if (technical.vwapW) {
    block = block.replace(
      /(<tr><td>Weekly VWAP<\/td><td[^>]*>)\$[\d.,]+/,
      `$1${fmt$(technical.vwapW)}`
    );
  }
  if (technical.vwapM) {
    block = block.replace(
      /(<tr><td>Monthly VWAP<\/td><td[^>]*>)\$[\d.,]+/,
      `$1${fmt$(technical.vwapM)}`
    );
  }
  if (technical.vwapQ) {
    block = block.replace(
      /(<tr><td>Quarterly VWAP<\/td><td[^>]*>)\$[\d.,]+/,
      `$1${fmt$(technical.vwapQ)}`
    );
  }

  // 5. Update Avg Volume
  if (technical.avgVol30) {
    const volM = (technical.avgVol30 / 1e6).toFixed(1);
    block = block.replace(
      /(<tr><td>Avg Volume \(30D\)<\/td><td[^>]*>)[\d.]+M shares/,
      `$1${volM}M shares`
    );
  }

  return html.substring(0, startIdx) + block + html.substring(endIdx);
}

// ── Update FALLBACK quant data ──

function updateFallbackData(html, quotes, technicalData) {
  // Update Monte Carlo mc arrays
  const mcData = {};
  for (const q of quotes) {
    mcData[q.symbol] = monteCarlo(q.price, VOL_MAP[q.symbol] || 0.5, 5000, 252);
  }

  // Update comp current prices
  for (const q of quotes) {
    const re = new RegExp(`(${q.symbol}\\s*:\\s*\\{[^}]*fair:\\s*\\d+,\\s*cur:\\s*)\\d+`, 'g');
    html = html.replace(re, `$1${Math.round(q.price)}`);
  }

  // Update mc arrays
  for (const sym of SYMBOLS) {
    if (!mcData[sym]) continue;
    const mcStr = JSON.stringify(mcData[sym]).replace(/^\[/, '').replace(/\]$/, '');
    const mcBlockRe = new RegExp(`(mc:\\s*\\{[^}]*${sym}:\\s*\\[)[^\\]]+`, 'g');
    html = html.replace(mcBlockRe, `$1${mcStr}`);
  }

  // Update date stamps
  const today = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = `${months[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
  html = html.replace(/[A-Z][a-z]{2} \d{1,2}, 20\d{2}/g, dateStr);

  return html;
}

// ── Main ──

async function main() {
  console.log('Fetching stock data from Stooq...');
  const quotes = [];
  const technicalData = {};

  for (const sym of SYMBOLS) {
    try {
      const history = await fetchHistory(sym);
      const last = history[history.length - 1];
      const price = last.close;

      const ichimoku = calcIchimoku(history);
      const fibonacci = calcFibonacci(history);
      const pivots = calcPivots(last);
      const vwapW = calcVWAP(history, 5);
      const vwapM = calcVWAP(history, 22);
      const vwapQ = calcVWAP(history, 66);
      const avgVol30 = calcAvgVolume(history, 30);

      technicalData[sym] = { ichimoku, fibonacci, pivots, vwapW, vwapM, vwapQ, avgVol30 };

      quotes.push({
        symbol: sym,
        price,
        beta: BETA_MAP[sym] || 1.5,
        volume: last.volume,
        avgVolume: avgVol30,
      });
      console.log(`  ${sym}: $${price.toFixed(2)} | Ich T:${ichimoku.tenkan.toFixed(0)}/K:${ichimoku.kijun.toFixed(0)} | Fib 38.2%:$${fibonacci.fib382.toFixed(0)} | Pivot S1:$${pivots.s1.toFixed(0)}`);
    } catch (e) {
      console.error(`  ${sym}: FAILED - ${e.message}`);
    }
  }

  if (quotes.length === 0) {
    console.error('No data fetched. Aborting.');
    process.exit(1);
  }

  console.log('\nUpdating HTML files...');

  let html = fs.readFileSync(HTML_FILE, 'utf8');

  // Update technical sections for each stock
  for (const sym of SYMBOLS) {
    if (technicalData[sym]) {
      const q = quotes.find(x => x.symbol === sym);
      html = updateTechnicalSection(html, sym, q, technicalData[sym]);
    }
  }

  // Update FALLBACK quant data
  html = updateFallbackData(html, quotes, technicalData);

  fs.writeFileSync(HTML_FILE, html, 'utf8');
  console.log(`  Updated: ${HTML_FILE}`);

  // Sync to secondary file
  if (fs.existsSync(path.dirname(SECONDARY_FILE))) {
    fs.writeFileSync(SECONDARY_FILE, html, 'utf8');
    console.log(`  Synced: ${SECONDARY_FILE}`);
  }

  console.log('\nDone! Models + technical levels updated.');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
