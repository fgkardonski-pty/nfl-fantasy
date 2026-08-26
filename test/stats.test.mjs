/**
 * The statistics core is tested against closed-form values wherever one exists.
 * Everything the platform recommends is built on these functions, so "looks
 * about right" is not an acceptable standard here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, variance, stdev, quantile, median, pearson, erf, normalCdf, normalInv,
  logistic, clamp, shrink, softmax, cholesky, rankDesc, zscores, round,
  lnGamma, gammaP, gammaCdf, gammaInv, gammaQuantileMS, pGreater,
} from '../src/util/stats.mjs';

const close = (a, b, eps = 1e-6, msg) =>
  assert.ok(Math.abs(a - b) < eps, msg ?? `expected ${a} ≈ ${b} (within ${eps})`);

test('mean, variance and standard deviation', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(mean([]), 0);
  // Sample variance of 2,4,4,4,5,5,7,9 is 32/7
  close(variance([2, 4, 4, 4, 5, 5, 7, 9]), 32 / 7);
  close(stdev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
  assert.equal(variance([5]), 0, 'a single observation has no sample variance');
});

test('quantile matches the type-7 (numpy default) definition', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
  assert.equal(quantile([15, 20, 35, 40, 50], 0.25), 20);
  assert.equal(quantile([15, 20, 35, 40, 50], 0.75), 40);
  assert.equal(median([3, 1, 2]), 2, 'input need not be pre-sorted');
  assert.equal(quantile([], 0.5), 0);
});

test('pGreater counts strictly greater', () => {
  assert.equal(pGreater([1, 2, 3, 4], 2), 0.5);
  assert.equal(pGreater([1, 1, 1], 1), 0);
});

test('pearson correlation', () => {
  close(pearson([1, 2, 3], [2, 4, 6]), 1);
  close(pearson([1, 2, 3], [6, 4, 2]), -1);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0, 'zero variance gives zero correlation');
});

test('erf matches known values', () => {
  close(erf(0), 0);
  close(erf(1), 0.8427007929, 1e-6);
  close(erf(-1), -0.8427007929, 1e-6);
  close(erf(2), 0.9953222650, 1e-6);
});

test('normalCdf and normalInv are inverses at standard quantiles', () => {
  close(normalCdf(0), 0.5);
  close(normalCdf(1.959963985), 0.975, 1e-6);
  close(normalInv(0.975), 1.959963985, 1e-6);
  close(normalInv(0.5), 0);
  close(normalInv(0.025), -1.959963985, 1e-6);
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    close(normalCdf(normalInv(p)), p, 1e-6, `round trip at p=${p}`);
  }
});

test('logistic is stable at both extremes', () => {
  close(logistic(0), 0.5);
  assert.ok(logistic(800) === 1, 'no overflow for large positive input');
  assert.ok(logistic(-800) === 0, 'no overflow for large negative input');
  close(logistic(2), 1 / (1 + Math.exp(-2)));
});

test('clamp and shrink', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  // With equal sample size and prior strength, the result is the midpoint.
  assert.equal(shrink(10, 20, 4, 4), 15);
  assert.equal(shrink(10, 20, 0, 4), 20, 'no evidence returns the prior');
  assert.ok(shrink(10, 20, 100, 4) < 10.5, 'lots of evidence dominates the prior');
});

test('softmax sums to one and respects temperature', () => {
  const p = softmax([1, 2, 3]);
  close(p.reduce((a, b) => a + b, 0), 1);
  assert.ok(p[2] > p[1] && p[1] > p[0]);
  const hot = softmax([1, 2, 3], 100);
  assert.ok(Math.abs(hot[0] - hot[2]) < 0.05, 'high temperature flattens the distribution');
  const cold = softmax([1, 2, 3], 0.05);
  assert.ok(cold[2] > 0.99, 'low temperature concentrates on the maximum');
});

test('cholesky reproduces the original matrix', () => {
  const A = [[4, 2, 1], [2, 3, 0.5], [1, 0.5, 2]];
  const L = cholesky(A);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += L[i][k] * L[j][k];
      close(s, A[i][j], 1e-9, `L·Lᵀ[${i}][${j}]`);
    }
  }
});

test('cholesky ridges a non-positive-definite matrix rather than throwing', () => {
  // Correlation matrices assembled from pairwise heuristics are often slightly
  // indefinite; the simulator must keep running.
  const bad = [[1, 0.99, 0.99], [0.99, 1, -0.99], [0.99, -0.99, 1]];
  const L = cholesky(bad);
  assert.equal(L.length, 3);
  assert.ok(L.every((row) => row.every((v) => Number.isFinite(v))), 'all entries finite');
});

test('rankDesc and zscores', () => {
  assert.deepEqual(rankDesc([10, 30, 20]), [3, 1, 2]);
  const z = zscores([1, 2, 3]);
  close(mean(z), 0, 1e-12);
  assert.deepEqual(zscores([5, 5, 5]), [0, 0, 0], 'zero variance yields zero scores');
});

test('lnGamma matches factorials', () => {
  close(lnGamma(1), 0, 1e-9);
  close(lnGamma(5), Math.log(24), 1e-9);   // Γ(5) = 4! = 24
  close(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9);
});

test('gamma CDF matches the exponential and chi-squared closed forms', () => {
  // Gamma(shape=1, scale=s) is Exponential(1/s): F(x) = 1 - e^{-x/s}
  for (const x of [0.5, 1, 2, 5]) {
    close(gammaCdf(x, 1, 1), 1 - Math.exp(-x), 1e-9, `exponential at ${x}`);
    close(gammaCdf(x, 1, 2), 1 - Math.exp(-x / 2), 1e-9);
  }
  // Chi-squared with 2 df is Gamma(1, 2); its median is 2 ln 2.
  close(gammaInv(0.5, 1, 2), 2 * Math.log(2), 1e-6);
});

test('gammaInv inverts gammaCdf', () => {
  for (const shape of [0.7, 1, 3, 12]) {
    for (const p of [0.05, 0.25, 0.5, 0.9, 0.99]) {
      const x = gammaInv(p, shape, 2);
      close(gammaCdf(x, shape, 2), p, 1e-5, `shape=${shape} p=${p}`);
    }
  }
});

test('gammaQuantileMS is parameterised by mean and standard deviation', () => {
  const mu = 14; const sigma = 6;
  const med = gammaQuantileMS(0.5, mu, sigma);
  const p10 = gammaQuantileMS(0.1, mu, sigma);
  const p90 = gammaQuantileMS(0.9, mu, sigma);
  assert.ok(p10 < med && med < p90, 'quantiles are ordered');
  assert.ok(p10 > 0, 'the floor of a scoring distribution is never negative');
  assert.ok(med < mu, 'the gamma is right-skewed, so the median sits below the mean');
  assert.equal(gammaQuantileMS(0.5, 0, 5), 0, 'a zero mean yields zero');
  assert.equal(gammaQuantileMS(0.9, 10, 0), 10, 'zero variance is a point mass');
});

test('round returns a number, not a string', () => {
  assert.equal(round(1.2345, 2), 1.23);
  assert.equal(typeof round(1.2345, 2), 'number');
  assert.equal(round(2.5, 0), 3);
});
