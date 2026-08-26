/**
 * Seeded pseudo-random number generation and the distributions the simulator
 * samples from.
 *
 * Determinism is a product requirement, not a convenience: if the war room
 * tells you to bench a player, you must be able to re-run the exact simulation
 * that said so. Every MODELLING path in the platform draws from an explicitly
 * seeded Rng instance.
 *
 * The only two uses of Math.random() in the codebase are network retry backoff
 * jitter (src/util/http.mjs) and research-job start jitter
 * (src/research/daemon.mjs). Both are deliberately non-reproducible: jitter
 * exists precisely to decorrelate timing, and seeding it would defeat its
 * purpose. Neither touches a projection, a simulation, or a recommendation.
 */

/** SplitMix64-style hash used to expand a string or number into a 32-bit seed. */
export function hashSeed(input) {
  const s = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Final avalanche so adjacent seeds ("week-1", "week-2") decorrelate.
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  /** @param {number|string} seed */
  constructor(seed = 8675309) {
    this.s = hashSeed(seed) || 1;
    this._spare = null;
  }

  /** xorshift32 — fast, adequate for Monte Carlo, fully reproducible. */
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x >>> 0;
    return this.s;
  }

  /** Uniform on [0, 1). */
  uniform() {
    return this.next() / 4294967296;
  }

  /** Uniform on [lo, hi). */
  range(lo, hi) {
    return lo + this.uniform() * (hi - lo);
  }

  /** Uniform integer on [lo, hi] inclusive. */
  int(lo, hi) {
    return lo + Math.floor(this.uniform() * (hi - lo + 1));
  }

  bool(p = 0.5) {
    return this.uniform() < p;
  }

  /** Standard normal via Marsaglia polar method, caching the spare deviate. */
  normal(mu = 0, sigma = 1) {
    if (this._spare !== null) {
      const v = this._spare;
      this._spare = null;
      return mu + sigma * v;
    }
    let u; let v; let s;
    do {
      u = this.uniform() * 2 - 1;
      v = this.uniform() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * f;
    return mu + sigma * u * f;
  }

  /**
   * Truncated normal via rejection, with a hard iteration cap so a pathological
   * (mu, sigma, lo) triple degrades to a clamp instead of hanging the server.
   */
  truncNormal(mu, sigma, lo = -Infinity, hi = Infinity) {
    for (let i = 0; i < 64; i++) {
      const x = this.normal(mu, sigma);
      if (x >= lo && x <= hi) return x;
    }
    return Math.min(hi, Math.max(lo, mu));
  }

  /**
   * Gamma(shape, scale) via Marsaglia–Tsang. This is the workhorse for
   * fantasy scoring: real weekly distributions are right-skewed (a floor at
   * zero, a long ceiling tail) and a gamma fits that far better than a normal.
   */
  gamma(shape, scale = 1) {
    if (shape <= 0) return 0;
    if (shape < 1) {
      // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
      const u = Math.max(1e-12, this.uniform());
      return this.gamma(shape + 1, scale) * u ** (1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x; let v;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.uniform();
      if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  /**
   * Gamma parameterised by the mean and standard deviation we actually carry
   * around on a projection. Falls back to a point mass when sd is ~0.
   */
  gammaMS(mu, sigma) {
    if (sigma <= 1e-9 || mu <= 1e-9) return Math.max(0, mu);
    const shape = (mu / sigma) ** 2;
    const scale = (sigma * sigma) / mu;
    return this.gamma(shape, scale);
  }

  poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k++; p *= this.uniform(); } while (p > L);
    return k - 1;
  }

  bernoulli(p) {
    return this.uniform() < p ? 1 : 0;
  }

  /** Draw an index from an array of non-negative weights. */
  weightedIndex(weights) {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.int(0, weights.length - 1);
    let r = this.uniform() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  /** In-place Fisher–Yates. Returns the same array for chaining. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** n iid standard normals. */
  normals(n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.normal();
    return out;
  }
}

/**
 * Draw a correlated standard-normal vector given the Cholesky factor L.
 * z ~ N(0, I)  =>  L·z ~ N(0, L·Lᵀ)
 */
export function correlatedNormals(rng, L, out) {
  const n = L.length;
  const z = rng.normals(n);
  const res = out || new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const Li = L[i];
    for (let j = 0; j <= i; j++) s += Li[j] * z[j];
    res[i] = s;
  }
  return res;
}
