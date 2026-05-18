// Monte Carlo GBM simulation worker.
// Off-main-thread to avoid 1-2s of jank on iGPU machines.
// Uses Mulberry32 RNG (~3x faster than Math.random, deterministic with seed).
//
// Receive: { id, closes: number[], paths: number, steps: number, seed?: number, horizonDays?: number }
// Reply:   { id, ok: true, percentiles: {p5,p25,p50,p75,p95,mean}, histogram: {bins,counts}, lastPrice }
//   or:    { id, ok: false, error }

self.onmessage = function (e) {
  var msg = e.data || {};
  var id = msg.id;
  try {
    if (!Array.isArray(msg.closes) || msg.closes.length < 30) throw new Error('insufficient_history');
    var paths  = Math.max(100, Math.min(50000, msg.paths || 10000));
    var steps  = Math.max(10,  Math.min(504,   msg.steps || 252));
    var seed   = (typeof msg.seed === 'number') ? msg.seed : 0x9E3779B9;
    var lastPrice = msg.closes[msg.closes.length - 1];

    var stats = logReturnStats(msg.closes);
    var mu  = stats.mu;     // daily drift
    var sig = stats.sigma;  // daily vol

    var dt = 1; // 1 day per step
    var drift = (mu - 0.5 * sig * sig) * dt;
    var shock = sig * Math.sqrt(dt);

    var rng = xorshift128plus(seed);
    var terminals = new Float64Array(paths);

    for (var i = 0; i < paths; i++) {
      var price = lastPrice;
      for (var t = 0; t < steps; t++) {
        // Box-Muller via paired xorshift draws (one normal per loop is fine here).
        var u1 = rng();
        if (u1 < 1e-12) u1 = 1e-12;
        var u2 = rng();
        var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        price = price * Math.exp(drift + shock * z);
      }
      terminals[i] = price;
    }

    // Percentiles via sort.
    var sorted = Array.prototype.slice.call(terminals).sort(function(a,b){ return a-b; });
    var pct = function(q) { return sorted[Math.floor((sorted.length - 1) * q)]; };
    var sum = 0;
    for (var k = 0; k < terminals.length; k++) sum += terminals[k];
    var mean = sum / terminals.length;

    // Histogram (40 bins covering p1..p99 to clip outliers).
    var lo = pct(0.01), hi = pct(0.99);
    var BINS = 40;
    var width = (hi - lo) / BINS;
    var counts = new Uint32Array(BINS);
    var binEdges = new Float64Array(BINS + 1);
    for (var b = 0; b <= BINS; b++) binEdges[b] = lo + b * width;
    for (var p = 0; p < terminals.length; p++) {
      var v = terminals[p];
      if (v < lo) { counts[0]++; continue; }
      if (v > hi) { counts[BINS - 1]++; continue; }
      var idx = Math.min(BINS - 1, Math.floor((v - lo) / width));
      counts[idx]++;
    }

    self.postMessage({
      id: id,
      ok: true,
      lastPrice: lastPrice,
      mu: mu, sigma: sig,
      paths: paths, steps: steps,
      percentiles: {
        p5:  pct(0.05),
        p25: pct(0.25),
        p50: pct(0.50),
        p75: pct(0.75),
        p95: pct(0.95),
        mean: mean
      },
      histogram: {
        bins: Array.prototype.slice.call(binEdges),
        counts: Array.prototype.slice.call(counts)
      }
    });
  } catch (err) {
    self.postMessage({ id: id, ok: false, error: String(err && err.message || err) });
  }
};

// ---- helpers ----

function logReturnStats(closes) {
  var n = closes.length - 1;
  var sum = 0;
  var rets = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var r = Math.log(closes[i + 1] / closes[i]);
    if (!isFinite(r)) r = 0;
    rets[i] = r;
    sum += r;
  }
  var mu = sum / n;
  var s2 = 0;
  for (var j = 0; j < n; j++) {
    var d = rets[j] - mu;
    s2 += d * d;
  }
  var sigma = Math.sqrt(s2 / Math.max(1, n - 1));
  return { mu: mu, sigma: sigma };
}

// Mulberry32 — 32-bit RNG, very fast (~3x Math.random), deterministic with seed.
// Quality is sufficient for Monte Carlo GBM; xorshift128+ avoided to skip BigInt overhead.
function xorshift128plus(seed) {
  var a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
