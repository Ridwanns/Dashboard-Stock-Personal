#!/usr/bin/env node
// update-quant-models.js
// Fetches latest financial data and recalculates quant model FALLBACK values in index.html.
// Run via: node scripts/update-quant-models.js
// Or via GitHub Actions cron (see .github/workflows/update-models.yml)

const https = require('https');
const fs = require('fs');
const path = require('path');

const SYMBOLS = ['MU', 'AMD', 'NVDA', 'TSM'];
const HTML_FILE = path.join(__dirname, '..', 'index.html');
const SECONDARY_FILE = path.resolve(__dirname, '..', '..', 'stock-dashboard-new.html');

// ── HTTP helper ──

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuantUpdate/1.0)',
        'Accept': 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          resolve(JSON.parse(body));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// ── Fetch stock data from Yahoo Finance ──

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}&lang=en-US&region=US`;
  const data = await fetchJSON(url);
  const q = data?.quoteResponse?.result?.[0];
  if (!q) throw new Error(`No data for ${symbol}`);
  return {
    symbol: q.symbol,
    price: q.regularMarketPrice,
    marketCap: q.marketCap,
    pe: q.trailingPE,
    forwardPE: q.forwardPE,
    eps: q.epsTrailingTwelveMonths,
    high52w: q.fiftyTwoWeekHigh,
    low52w: q.fiftyTwoWeekLow,
    beta: q.beta,
    volume: q.regularMarketVolume,
    avgVolume: q.averageDailyVolume3Month,
  };
}

// ── Monte Carlo simulation (simplified) ──

function monteCarlo(currentPrice, annualVol, simulations, days) {
  const dailyVol = annualVol / Math.sqrt(252);
  const dailyDrift = 0.0002; // ~5% annual drift
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

// ── Risk metrics calculation ──

function calcRiskMetrics(quote) {
  const beta = quote.beta || 1.2;
  const vol = beta * 30; // simplified annual vol estimate
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

// ── Update HTML file ──

function updateFallbackData(html, quotes) {
  const VOL_MAP = { MU: 0.58, AMD: 0.52, NVDA: 0.55, TSM: 0.42 };

  // Update Monte Carlo
  const mcData = {};
  for (const q of quotes) {
    mcData[q.symbol] = monteCarlo(q.price, VOL_MAP[q.symbol] || 0.5, 5000, 252);
  }

  // Update comp (composite valuation) current prices
  for (const q of quotes) {
    const re = new RegExp(`(${q.symbol}\\s*:\\s*\\{[^}]*fair:\\s*\\d+,\\s*cur:\\s*)\\d+`, 'g');
    html = html.replace(re, `$1${Math.round(q.price)}`);
  }

  // Update mc arrays
  for (const sym of SYMBOLS) {
    if (!mcData[sym]) continue;
    const mcStr = JSON.stringify(mcData[sym]).replace(/^\[/, '').replace(/\]$/, '');
    const re = new RegExp(`(${sym}:\\s*\\[)[^\\]]+\\]`, 'g');
    // Only replace inside mc block — use more specific pattern
    const mcBlockRe = new RegExp(`(mc:\\s*\\{[^}]*${sym}:\\s*\\[)[^\\]]+`, 'g');
    html = html.replace(mcBlockRe, `$1${mcStr}`);
  }

  // Update risk metrics
  for (const q of quotes) {
    const risk = calcRiskMetrics(q);
    const riskJSON = JSON.stringify(risk);
    // Replace risk array for each symbol
    const riskRe = new RegExp(
      `(${q.symbol}:\\s*\\[\\s*\\{label:'Sharpe')[^\\]]+\\]`,
      'g'
    );
    const newRisk = risk.map(r =>
      `{label:'${r.label}', display:'${r.display}', normalized:${r.normalized}}`
    ).join(',\n            ');
    html = html.replace(riskRe, `$1`.replace(`{label:'Sharpe'`, '') + newRisk + ']');
  }

  // Update date stamps
  const today = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = `${months[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
  html = html.replace(/May 18, 2026/g, dateStr);

  return html;
}

// ── Main ──

async function main() {
  console.log('Fetching stock data...');
  const quotes = [];

  for (const sym of SYMBOLS) {
    try {
      const q = await fetchQuote(sym);
      quotes.push(q);
      console.log(`  ${sym}: $${q.price} (P/E: ${q.pe?.toFixed(1) || 'N/A'})`);
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
  html = updateFallbackData(html, quotes);
  fs.writeFileSync(HTML_FILE, html, 'utf8');
  console.log(`  Updated: ${HTML_FILE}`);

  // Sync to secondary file
  if (fs.existsSync(path.dirname(SECONDARY_FILE))) {
    fs.writeFileSync(SECONDARY_FILE, html, 'utf8');
    console.log(`  Synced: ${SECONDARY_FILE}`);
  }

  console.log('\nDone! Quant models updated successfully.');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
