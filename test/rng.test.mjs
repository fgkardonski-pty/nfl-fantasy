/**
 * Determinism is a product requirement: if the platform tells you to bench a
 * player, you must be able to reproduce the simulation that said so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng, hashSeed, correlatedNormals } from '../src/util/rng.mjs';
import { mean, stdevPop, pearson, cholesky, quantile } from '../src/util/stats.mjs';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, msg ?? `${a} ≈ ${b} ±${eps}`);

test('the same seed always produces the same stream', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  for (let i = 0; i < 500; i++) assert.equal(a.uniform(), b.uniform());
});

test('different seeds produce different streams', () => {
  const a = new Rng('week-1');
  const b = new Rng('week-2');
  const sa = Array.from({ length: 50 }, () => a.uniform());
  const sb = Array.from({ length: 50 }, () => b.uniform());
  assert.notDeepEqual(sa, sb);
  assert.ok(Math.abs(pearson(sa, sb)) < 0.35, 'adjacent seeds decorrelate');
});

test('hashSeed is stable and non-zero', () => {
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  assert.notEqual(hashSeed('abc'), hashSeed('abd'));
  assert.ok(hashSeed('') >= 0);
});

test('uniform stays in [0,1) and is roughly flat', () => {
  const r = new Rng(7);
  const xs = Array.from({ length: 100000 }, () => r.uniform());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  close(mean(xs), 0.5, 0.01);
  // Chi-square-ish flatness check across ten buckets.
  const buckets = new Array(10).fill(0);
  for (const x of xs) buckets[Math.floor(x * 10)]++;
  for (const b of buckets) assert.ok(Math.abs(b - 10000) < 700, `bucket ${b} is near-uniform`);
});

test('normal has the requested mean and standard deviation', () => {
  const r = new Rng(99);
  const xs = Array.from({ length: 200000 }, () => r.normal(12, 3));
  close(mean(xs), 12, 0.05);
  close(stdevPop(xs), 3, 0.05);
  // Symmetry: the median of a normal equals its mean.
  close(quantile(xs, 0.5), 12, 0.06);
});

test('gammaMS matches the requested mean and standard deviation', () => {
  const r = new Rng(5);
  for (const [mu, sigma] of [[14, 6], [4, 4], [25, 8], [1, 0.5]]) {
    const xs = Array.from({ length: 120000 }, () => r.gammaMS(mu, sigma));
    close(mean(xs), mu, mu * 0.02, `mean for μ=${mu}`);
    close(stdevPop(xs), sigma, sigma * 0.04, `sd for σ=${sigma}`);
    assert.ok(xs.every((x) => x >= 0), 'gamma samples are never negative');
  }
});

test('gammaMS degrades gracefully at the boundaries', () => {
  const r = new Rng(1);
  assert.equal(r.gammaMS(0, 5), 0);
  assert.equal(r.gammaMS(10, 0), 10);
  assert.ok(r.gammaMS(-3, 2) >= 0);
});

test('truncNormal respects its bounds', () => {
  const r = new Rng(3);
  for (let i = 0; i < 5000; i++) {
    const x = r.truncNormal(10, 5, 0, 20);
    assert.ok(x >= 0 && x <= 20);
  }
  // A bound the distribution cannot reach must clamp, not hang.
  const x = r.truncNormal(0, 1, 100, 200);
  assert.ok(x >= 100 && x <= 200);
});

test('poisson has mean equal to lambda', () => {
  const r = new Rng(21);
  for (const lambda of [0.5, 3, 12]) {
    const xs = Array.from({ length: 60000 }, () => r.poisson(lambda));
    close(mean(xs), lambda, Math.max(0.05, lambda * 0.03), `λ=${lambda}`);
    assert.ok(xs.every((x) => Number.isInteger(x) && x >= 0));
  }
  assert.equal(r.poisson(0), 0);
});

test('weightedIndex respects the weights', () => {
  const r = new Rng(11);
  const counts = [0, 0, 0];
  for (let i = 0; i < 60000; i++) counts[r.weightedIndex([1, 3, 6])]++;
  close(counts[0] / 60000, 0.1, 0.01);
  close(counts[1] / 60000, 0.3, 0.015);
  close(counts[2] / 60000, 0.6, 0.015);
  // All-zero weights must not throw or bias.
  assert.ok([0, 1, 2].includes(r.weightedIndex([0, 0, 0])));
});

test('shuffle is a permutation', () => {
  const r = new Rng(4);
  const arr = Array.from({ length: 200 }, (_, i) => i);
  const out = r.shuffle([...arr]);
  assert.deepEqual([...out].sort((a, b) => a - b), arr);
  assert.notDeepEqual(out, arr, 'the order actually changed');
});

test('correlatedNormals induces the target correlation', () => {
  for (const target of [-0.6, -0.2, 0, 0.35, 0.8]) {
    const L = cholesky([[1, target], [target, 1]]);
    const r = new Rng(13);
    const a = []; const b = [];
    for (let i = 0; i < 60000; i++) {
      const v = correlatedNormals(r, L);
      a.push(v[0]); b.push(v[1]);
    }
    close(pearson(a, b), target, 0.02, `target correlation ${target}`);
    close(stdevPop(a), 1, 0.02, 'marginals remain standard normal');
  }
});
