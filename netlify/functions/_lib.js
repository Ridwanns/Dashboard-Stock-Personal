// Shared utilities for all Netlify functions.
// Kept dependency-free (only Node stdlib) so functions stay fast and cold-start cheap.

const https = require('https');

// ---------- HTTP helpers ----------

const DEFAULT_UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// fetchText: GET a URL, return { status, headers, body } where body is a string.
// Default timeout 10s. Rejects on network error; resolves with non-2xx statuses.
function fetchText(url, opts = {}) {
  const headers = Object.assign(
    {
      'User-Agent': DEFAULT_UA,
      'Accept': opts.accept || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    opts.headers || {}
  );
  const timeoutMs = opts.timeoutMs || 10000;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function fetchJSON(url, opts = {}) {
  const r = await fetchText(url, Object.assign({ accept: 'application/json' }, opts));
  if (r.status >= 400) {
    const err = new Error('http_' + r.status);
    err.status = r.status;
    err.body = r.body.slice(0, 500);
    throw err;
  }
  // Yahoo sometimes returns HTML on rate-limit even with a 200 — detect and reject.
  const trimmed = r.body.trim();
  if (trimmed.startsWith('<')) {
    const err = new Error('html_response');
    err.status = 503;
    err.body = trimmed.slice(0, 200);
    throw err;
  }
  try {
    return JSON.parse(r.body);
  } catch (e) {
    const err = new Error('invalid_json');
    err.status = 502;
    err.body = r.body.slice(0, 200);
    throw err;
  }
}

// ---------- Response builders ----------

function ok(payload, opts = {}) {
  const ttl = typeof opts.sMaxAge === 'number' ? opts.sMaxAge : 60;
  const swr = typeof opts.swr === 'number' ? opts.swr : Math.max(ttl * 2, 120);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
    },
    body: JSON.stringify(payload),
  };
}

function fail(status, code, extra = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(Object.assign({ error: code }, extra)),
  };
}

// ---------- Input validation ----------

// Yahoo / Stooq symbols. Allows tickers like NVDA, BRK.B, ^GSPC, SMIC.HK.
const SYMBOL_RE = /^\^?[A-Z][A-Z0-9.\-]{0,9}$/;

function cleanSymbol(s) {
  if (typeof s !== 'string') return null;
  const up = s.trim().toUpperCase();
  return SYMBOL_RE.test(up) ? up : null;
}

function cleanSymbolList(s, max = 12) {
  if (typeof s !== 'string') return [];
  const out = [];
  for (const part of s.split(',')) {
    const c = cleanSymbol(part);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

// ---------- Schema validator (tiny) ----------

// Walks `obj` following a dotted path; returns fallback on missing intermediate node.
function safeGet(obj, path, fallback) {
  if (!obj) return fallback;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[p];
  }
  return cur == null ? fallback : cur;
}

// validateShape: confirms required top-level keys exist; returns missing list.
function validateShape(obj, requiredKeys) {
  const missing = [];
  if (!obj || typeof obj !== 'object') return requiredKeys.slice();
  for (const k of requiredKeys) {
    if (!(k in obj)) missing.push(k);
  }
  return missing;
}

// ---------- Warm-container cache ----------

// Simple TTL map. Cleared when the Lambda container recycles.
function makeCache(maxEntries = 64) {
  const m = new Map();
  return {
    get(key) {
      const entry = m.get(key);
      if (!entry) return null;
      if (entry.exp < Date.now()) {
        m.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (m.size >= maxEntries) {
        // Drop oldest.
        const first = m.keys().next().value;
        if (first) m.delete(first);
      }
      m.set(key, { value, exp: Date.now() + ttlMs });
    },
  };
}

// ---------- Token bucket rate-limit ----------

// Per-IP token bucket. Best-effort (warm container scope).
function makeTokenBucket(maxPerMinute = 30) {
  const buckets = new Map();
  return function allow(ip) {
    const now = Date.now();
    const b = buckets.get(ip) || { tokens: maxPerMinute, ts: now };
    const elapsed = (now - b.ts) / 60000;
    b.tokens = Math.min(maxPerMinute, b.tokens + elapsed * maxPerMinute);
    b.ts = now;
    if (b.tokens < 1) {
      buckets.set(ip, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    return true;
  };
}

function clientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

// ---------- HTML escape (for news titles, etc.) ----------

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHTML(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

// ---------- Mobile UA detection ----------

function isMobile(event) {
  const ua = ((event.headers || {})['user-agent'] || '').toLowerCase();
  return /mobi|android|iphone|ipad|ipod|opera mini|iemobile/.test(ua);
}

module.exports = {
  fetchText,
  fetchJSON,
  ok,
  fail,
  cleanSymbol,
  cleanSymbolList,
  safeGet,
  validateShape,
  makeCache,
  makeTokenBucket,
  clientIp,
  escapeHTML,
  isMobile,
};
