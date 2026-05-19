#!/usr/bin/env node
// update-fundamentals.js
// Refreshes the FALLBACK valuation metrics + analyst targets in
// netlify/functions/financials.js by querying Yahoo v10 quoteSummary.
// Run via: node scripts/update-fundamentals.js
// Or via GitHub Actions cron (see .github/workflows/update-fundamentals.yml)

const https = require('https');
const fs = require('fs');
const path = require('path');

const SYMBOLS = ['MU', 'AMD', 'NVDA', 'TSM'];
const TARGET = path.join(__dirname, '..', 'netlify', 'functions', 'financials.js');

// Fields that we attempt to refresh weekly from Yahoo
const FIELDS = [
  'forwardPE', 'trailingPE', 'priceToSales', 'priceToBook', 'evToEbitda',
  'forwardEPS', 'trailingEPS', 'currentPrice',
  'targetMeanPrice', 'targetHighPrice', 'targetLowPrice',
  'numberOfAnalystOpinions', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'beta',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Generic HTTPS GET that also returns the raw response so we can capture cookies.
function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'application/json,text/csv,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    }, opts.headers || {});
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // Follow simple redirects (3xx) once
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && !opts._noRedirect) {
          return resolve(httpGet(res.headers.location, Object.assign({ _noRedirect: true }, opts)));
        }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// Get Yahoo Finance session (cookie + crumb) required for v10 quoteSummary.
// Without these, Yahoo returns HTTP 401 'Invalid Cookie'.
let _yahooSession = null;
async function getYahooSession() {
  if (_yahooSession) return _yahooSession;
  // Step 1: Hit fc.yahoo.com to get session cookies
  const cookieResp = await httpGet('https://fc.yahoo.com/', {});
  // It returns 404 but sets the cookies we need
  const setCookie = cookieResp.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no Yahoo session cookie');

  // Step 2: Exchange cookie for crumb
  const crumbResp = await httpGet('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { Cookie: cookie },
  });
  if (crumbResp.status !== 200) throw new Error('crumb HTTP ' + crumbResp.status);
  const crumb = crumbResp.body.trim();
  if (!crumb || crumb.length < 4) throw new Error('empty crumb');

  _yahooSession = { cookie, crumb };
  return _yahooSession;
}

async function fetchJSON(url, withCrumb = true) {
  let finalUrl = url;
  let cookieHeader = '';
  if (withCrumb) {
    try {
      const sess = await getYahooSession();
      const sep = url.includes('?') ? '&' : '?';
      finalUrl = url + sep + 'crumb=' + encodeURIComponent(sess.crumb);
      cookieHeader = sess.cookie;
    } catch (e) {
      // Proceed without crumb — some endpoints still work
    }
  }
  const resp = await httpGet(finalUrl, {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  if (resp.status >= 400) {
    // If we hit 401 once, invalidate the session and let the caller retry once
    if (resp.status === 401) _yahooSession = null;
    throw new Error('HTTP ' + resp.status);
  }
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new Error('JSON parse: ' + e.message);
  }
}

function unwrap(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'object' && 'raw' in v) return isFinite(v.raw) ? v.raw : null;
  return null;
}

function getPath(obj, path) {
  const parts = path.split('.');
  let v = obj;
  for (const p of parts) {
    if (v == null) return null;
    v = v[p];
  }
  return v;
}

async function fetchValuation(symbol) {
  const modules = ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'price'].join(',');
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}`;
  let j;
  try {
    j = await fetchJSON(url);
  } catch (e) {
    // One retry with a fresh session if first attempt 401'd
    if (String(e.message).includes('401')) {
      _yahooSession = null;
      j = await fetchJSON(url);
    } else {
      throw e;
    }
  }
  const r = getPath(j, 'quoteSummary.result.0');
  if (!r) throw new Error('empty quoteSummary');
  return {
    forwardPE: unwrap(getPath(r, 'summaryDetail.forwardPE')) || unwrap(getPath(r, 'defaultKeyStatistics.forwardPE')),
    trailingPE: unwrap(getPath(r, 'summaryDetail.trailingPE')),
    priceToSales: unwrap(getPath(r, 'summaryDetail.priceToSalesTrailing12Months')),
    priceToBook: unwrap(getPath(r, 'defaultKeyStatistics.priceToBook')),
    evToEbitda: unwrap(getPath(r, 'defaultKeyStatistics.enterpriseToEbitda')),
    forwardEPS: unwrap(getPath(r, 'defaultKeyStatistics.forwardEps')),
    trailingEPS: unwrap(getPath(r, 'defaultKeyStatistics.trailingEps')),
    currentPrice: unwrap(getPath(r, 'financialData.currentPrice')) || unwrap(getPath(r, 'price.regularMarketPrice')),
    targetMeanPrice: unwrap(getPath(r, 'financialData.targetMeanPrice')),
    targetHighPrice: unwrap(getPath(r, 'financialData.targetHighPrice')),
    targetLowPrice: unwrap(getPath(r, 'financialData.targetLowPrice')),
    numberOfAnalystOpinions: unwrap(getPath(r, 'financialData.numberOfAnalystOpinions')),
    fiftyTwoWeekHigh: unwrap(getPath(r, 'summaryDetail.fiftyTwoWeekHigh')),
    fiftyTwoWeekLow: unwrap(getPath(r, 'summaryDetail.fiftyTwoWeekLow')),
    beta: unwrap(getPath(r, 'defaultKeyStatistics.beta')) || unwrap(getPath(r, 'summaryDetail.beta')),
  };
}

function formatVal(field, val) {
  if (field === 'numberOfAnalystOpinions') return Math.round(val).toString();
  // Two decimals is plenty for ratios and prices
  return (+val).toFixed(2);
}

function findBlock(src, sym) {
  // Locate the per-symbol FALLBACK block: "  SYM: {" through matching "}"
  const marker = new RegExp(`^\\s\\s${sym}:\\s*\\{`, 'm');
  const m = marker.exec(src);
  if (!m) return null;
  const start = m.index;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

function patchBlock(block, data) {
  let updated = block;
  let n = 0;
  for (const f of FIELDS) {
    const v = data[f];
    if (v == null) continue;
    const re = new RegExp(`(${f}:\\s*)-?[\\d.eE+]+`);
    if (re.test(updated)) {
      updated = updated.replace(re, `$1${formatVal(f, v)}`);
      n++;
    }
  }
  return { updated, n };
}

async function main() {
  console.log('Fetching valuation snapshots from Yahoo...');
  const results = {};
  for (const sym of SYMBOLS) {
    try {
      results[sym] = await fetchValuation(sym);
      const d = results[sym];
      console.log(`  ${sym}: fwdPE=${d.forwardPE} | price=$${d.currentPrice} | target=$${d.targetMeanPrice} | n=${d.numberOfAnalystOpinions}`);
    } catch (e) {
      console.error(`  ${sym}: FAILED - ${e.message}`);
    }
    // Small spacing to be polite to the API
    await new Promise((r) => setTimeout(r, 1200));
  }

  const ok = Object.keys(results).length;
  if (ok === 0) {
    // Soft-fail: don't crash the workflow when Yahoo is fully rate-limiting.
    // The FALLBACK in financials.js still serves users with the last good values.
    console.warn('No data fetched this run. Existing FALLBACK values remain in place.');
    return;
  }

  console.log('\nPatching FALLBACK in financials.js...');
  let src = fs.readFileSync(TARGET, 'utf8');
  const sentinel = 'const FALLBACK = {';
  if (!src.includes(sentinel)) {
    console.error('FALLBACK constant not found. Aborting.');
    process.exit(1);
  }

  let touched = 0;
  for (const sym of SYMBOLS) {
    if (!results[sym]) continue;
    const block = findBlock(src, sym);
    if (!block) {
      console.warn(`  ${sym}: block not found, skipping`);
      continue;
    }
    const original = src.substring(block.start, block.end);
    const { updated, n } = patchBlock(original, results[sym]);
    if (n === 0 || updated === original) continue;
    src = src.substring(0, block.start) + updated + src.substring(block.end);
    console.log(`  ${sym}: ${n} fields patched`);
    touched++;
  }

  if (touched === 0) {
    console.log('No fields changed.');
    return;
  }

  fs.writeFileSync(TARGET, src, 'utf8');
  console.log(`\nDone. Updated ${touched} symbols in ${TARGET}`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
