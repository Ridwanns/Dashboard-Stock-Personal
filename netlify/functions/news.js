// /api/news?symbol=NVDA[&limit=10]
// Server-side Yahoo Finance RSS proxy with HTML-escaped titles.
// Replaces fragile direct browser → feeds.finance.yahoo.com → api.rss2json.com chain.

const {
  fetchText,
  ok,
  fail,
  cleanSymbol,
  escapeHTML,
  makeCache,
  makeTokenBucket,
  clientIp,
} = require('./_lib');

const CACHE = makeCache(16);
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min
const allow = makeTokenBucket(60);

exports.handler = async (event) => {
  if (!allow(clientIp(event))) return fail(429, 'rate_limited', { retryAfter: 60 });

  const qp = event.queryStringParameters || {};
  const symbol = cleanSymbol(qp.symbol || '');
  if (!symbol) return fail(400, 'bad_symbol');
  const limit = Math.min(parseInt(qp.limit, 10) || 10, 30);

  const cacheKey = `${symbol}|${limit}`;
  const cached = CACHE.get(cacheKey);
  if (cached) return ok(cached, { sMaxAge: 300, swr: 600 });

  try {
    const url =
      'https://feeds.finance.yahoo.com/rss/2.0/headline?s=' +
      encodeURIComponent(symbol) +
      '&region=US&lang=en-US';
    const r = await fetchText(url, { accept: 'application/rss+xml,application/xml,text/xml', timeoutMs: 9000 });
    if (r.status >= 400) throw new Error('http_' + r.status);

    const items = parseRSS(r.body, limit);
    if (items.length === 0) throw new Error('empty');

    const payload = { symbol, count: items.length, items, ts: Date.now() };
    CACHE.set(cacheKey, payload, CACHE_TTL_MS);
    return ok(payload, { sMaxAge: 300, swr: 600 });
  } catch (e) {
    return fail(503, 'upstream_unavailable', { detail: String(e.message || e) });
  }
};

// Lightweight RSS 2.0 parser — sufficient for Yahoo's feed shape.
// Returns [{title, link, pubDate, source}], with titles HTML-escaped.
function parseRSS(xml, limit) {
  const out = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null && out.length < limit) {
    const block = m[1];
    out.push({
      title: escapeHTML(decodeXMLEntities(stripCDATA(extractTag(block, 'title')))),
      link: decodeXMLEntities(stripCDATA(extractTag(block, 'link'))).trim(),
      pubDate: stripCDATA(extractTag(block, 'pubDate')).trim(),
      source: escapeHTML(decodeXMLEntities(stripCDATA(extractTag(block, 'source')))),
    });
  }
  return out;
}

function extractTag(xml, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function stripCDATA(s) {
  if (!s) return '';
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

function decodeXMLEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
