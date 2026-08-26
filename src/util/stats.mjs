/**
 * Statistics core.
 *
 * Everything downstream — projections, simulation, win probability, FAAB
 * pricing — bottoms out here, so these functions are written for correctness
 * first and have direct unit tests in test/stats.test.mjs.
 */

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

/** Sample variance (Bessel-corrected). Returns 0 for n < 2. */
export function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}

export const stdev = (xs) => Math.sqrt(variance(xs));

/** Population standard deviation — used when xs is the whole simulated universe. */
export function stdevPop(xs) {
  if (!xs.length) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / xs.length);
}

/**
 * Linear-interpolated quantile (the "type 7" definition, same as numpy default).
 * `xs` need not be sorted.
 */
export function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length - 1];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (xs) => quantile(xs, 0.5);

/** Fraction of samples strictly greater than `t`. */
export function pGreater(xs, t) {
  if (!xs.length) return 0;
  let n = 0;
  for (const x of xs) if (x > t) n++;
  return n / xs.length;
}

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/**
 * Abramowitz & Stegun 7.1.26 error function, |error| < 1.5e-7.
 * Good enough for win probabilities that we report to one decimal.
 */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (x, mu = 0, sigma = 1) =>
  0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));

export const normalPdf = (x, mu = 0, sigma = 1) =>
  Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI));

/** Acklam's inverse normal CDF approximation. Relative error < 1.15e-9. */
export function normalInv(p, mu = 0, sigma = 1) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pl = 0.02425;
  let q;
  let r;
  let x;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return mu + sigma * x;
}

/** Numerically stable logistic. */
export function logistic(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Empirical-Bayes shrinkage of an observed mean toward a prior.
 * `n` is the observed sample size, `k` the prior strength in the same units:
 * with n === k the result sits exactly halfway.
 */
export function shrink(observed, prior, n, k) {
  if (n <= 0) return prior;
  const w = n / (n + k);
  return w * observed + (1 - w) * prior;
}

/** Softmax with temperature. Higher temperature => flatter distribution. */
export function softmax(xs, temperature = 1) {
  if (!xs.length) return [];
  const t = Math.max(1e-9, temperature);
  const scaled = xs.map((x) => x / t);
  const mx = Math.max(...scaled);
  const ex = scaled.map((x) => Math.exp(x - mx));
  const tot = sum(ex);
  return ex.map((e) => e / tot);
}

/**
 * Cholesky decomposition of a symmetric positive-definite matrix.
 * Returns lower-triangular L with L·Lᵀ = A.
 *
 * Correlation matrices assembled from heuristics are frequently *not* quite
 * positive definite, so we ridge-adjust the diagonal on failure and retry
 * rather than throwing. That keeps the simulator running on messy real input.
 */
export function cholesky(A) {
  const n = A.length;
  for (let attempt = 0; attempt < 8; attempt++) {
    const ridge = attempt === 0 ? 0 : 10 ** (attempt - 8);
    const L = Array.from({ length: n }, () => new Float64Array(n));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j] + (i === j ? ridge : 0);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) {
          if (s <= 0) { ok = false; break; }
          L[i][i] = Math.sqrt(s);
        } else {
          L[i][j] = s / L[j][j];
        }
      }
    }
    if (ok) return L;
  }
  // Total failure: fall back to independent sampling (identity scaled by sd 1).
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) L[i][i] = 1;
  return L;
}

/** Rank an array descending; returns 1-based ranks aligned with input order. */
export function rankDesc(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const out = new Array(xs.length);
  idx.forEach(([, i], r) => { out[i] = r + 1; });
  return out;
}

/** z-score each element against the array's own mean/sd. */
export function zscores(xs) {
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return xs.map(() => 0);
  return xs.map((x) => (x - m) / s);
}

/** Round to `p` decimal places, returning a Number (not a string). */
export const round = (x, p = 2) => {
  const f = 10 ** p;
  return Math.round((x + Number.EPSILON) * f) / f;
};

// ---------------------------------------------------------------------------
// Gamma distribution support.
//
// Weekly fantasy scoring is not normal: it has a hard floor at zero and a long
// right tail (the 38-point game). A gamma fit to the same mean and standard
// deviation matches that shape far better, so projection floors (p10) and
// ceilings (p90) are computed as true gamma quantiles rather than mean ± 1.28σ,
// which would put floors below zero for every low-usage player.
// ---------------------------------------------------------------------------

/** Lanczos approximation of ln Γ(x). */
export function lnGamma(x) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x). Series below the mean, continued fraction above. */
export function gammaP(a, x) {
  if (x <= 0 || a <= 0) return 0;
  if (x < a + 1) {
    // Series expansion.
    let ap = a;
    let del = 1 / a;
    let s = del;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      s += del;
      if (Math.abs(del) < Math.abs(s) * 1e-14) break;
    }
    return s * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // Lentz's continued fraction for Q(a,x), then P = 1 - Q.
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  return 1 - q;
}

export const gammaCdf = (x, shape, scale) => gammaP(shape, x / scale);

/** Gamma quantile by bracketed bisection on the CDF. Accurate to ~1e-6 relative. */
export function gammaInv(p, shape, scale) {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  if (shape <= 0 || scale <= 0) return 0;
  const mean = shape * scale;
  let lo = 0;
  let hi = Math.max(mean * 4, mean + 10 * Math.sqrt(shape) * scale, 1);
  while (gammaCdf(hi, shape, scale) < p && hi < 1e12) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaCdf(mid, shape, scale) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-9 * Math.max(1, hi)) break;
  }
  return (lo + hi) / 2;
}

/** Gamma quantile parameterised by mean and standard deviation. */
export function gammaQuantileMS(p, mu, sigma) {
  if (mu <= 1e-9) return 0;
  if (sigma <= 1e-9) return mu;
  const shape = (mu / sigma) ** 2;
  const scale = (sigma * sigma) / mu;
  return gammaInv(p, shape, scale);
}
