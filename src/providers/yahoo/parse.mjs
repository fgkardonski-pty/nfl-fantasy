/**
 * Yahoo Fantasy JSON normalisation.
 *
 * Yahoo's API returns one of the more hostile JSON shapes in public circulation.
 * Collections arrive as objects with stringified integer keys plus a `count`:
 *
 *   { "0": { "team": [...] }, "1": { "team": [...] }, "count": 2 }
 *
 * and individual entities arrive as ARRAYS of single-key objects that are meant
 * to be merged into one:
 *
 *   [ { "team_key": "..." }, { "name": "..." }, [ {...}, {...} ] ]
 *
 * Both shapes nest inside each other arbitrarily deep. Rather than let that leak
 * into business logic as `data[0][1][2].player[0].name`, every response is
 * normalised here, once, into ordinary objects and arrays — and this module has
 * direct unit tests against captured response shapes.
 */

/** True for Yahoo's `{"0":…, "1":…, count:N}` pseudo-array. */
export function isIndexedCollection(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!keys.length) return false;
  const numeric = keys.filter((k) => /^\d+$/.test(k));
  if (!numeric.length) return false;
  const others = keys.filter((k) => !/^\d+$/.test(k));
  // Yahoo attaches `count` (and occasionally nothing else) alongside the indices.
  return others.every((k) => k === 'count');
}

/** Convert an indexed collection into a plain array, dropping `count`. */
export function collectionToArray(v) {
  return Object.keys(v)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => v[k]);
}

/**
 * Merge Yahoo's array-of-fragments into a single object.
 * Nested arrays are flattened recursively; non-object members are dropped.
 */
export function mergeFragments(arr) {
  const out = {};
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'count') continue;
      const nv = normalise(v);
      // Do not let an empty fragment clobber a populated one.
      if (out[k] !== undefined && (nv === '' || nv == null)) continue;
      out[k] = nv;
    }
  };
  walk(arr);
  return out;
}

/**
 * Recursively normalise any Yahoo payload into plain JS.
 * Indexed collections become arrays; fragment arrays become merged objects.
 */
export function normalise(value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    // A Yahoo entity array is a list of fragments to merge; a genuine list of
    // entities is one where every element is itself an object with the same
    // single wrapper key (handled by the caller via collectionToArray).
    const objs = value.filter((v) => v && typeof v === 'object');
    if (objs.length && objs.length === value.length && looksLikeFragments(value)) {
      return mergeFragments(value);
    }
    return value.map(normalise);
  }
  if (typeof value === 'object') {
    if (isIndexedCollection(value)) return collectionToArray(value).map(normalise);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v);
    return out;
  }
  return value;
}

/**
 * Heuristic: a fragment array is one whose object members are small key/value
 * bags rather than full entities. Yahoo entity arrays mix flat fragments with
 * one nested array; genuine lists repeat the same wrapper key.
 */
function looksLikeFragments(arr) {
  const objs = arr.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
  if (!objs.length) return arr.some((v) => Array.isArray(v));
  const keySets = objs.map((o) => Object.keys(o).filter((k) => k !== 'count'));
  const singleWrapper = keySets.every((ks) => ks.length === 1);
  if (singleWrapper) {
    const names = new Set(keySets.map((ks) => ks[0]));
    // Same wrapper repeated => a real list (e.g. many {"team": ...}); different
    // wrappers => fragments of one entity.
    if (names.size === 1 && objs.length > 1) return false;
  }
  return true;
}

/**
 * Pull a named collection out of a normalised payload, tolerating the several
 * shapes Yahoo uses for the same thing.
 *
 * @param {any} node
 * @param {string} key  e.g. 'team', 'player', 'transaction'
 * @returns {Array<Object>}
 */
export function extractList(node, key) {
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    if (n == null || typeof n !== 'object') return;
    if (seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach(walk); return; }
    for (const [k, v] of Object.entries(n)) {
      if (k === key) {
        if (Array.isArray(v)) {
          // Either a list of entities or the fragments of one entity.
          const merged = mergeFragments(v);
          if (Object.keys(merged).length) out.push(merged);
        } else if (v && typeof v === 'object') {
          out.push(v);
        }
      } else if (k === `${key}s`) {
        const items = Array.isArray(v) ? v : (isIndexedCollection(v) ? collectionToArray(v) : [v]);
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const inner = item[key] ?? item;
          out.push(Array.isArray(inner) ? mergeFragments(inner) : inner);
        }
      } else {
        walk(v);
      }
    }
  };
  walk(node);
  return out.filter((o) => o && typeof o === 'object' && Object.keys(o).length);
}

/** The `fantasy_content` root, normalised. */
export function root(payload) {
  const fc = payload?.fantasy_content ?? payload;
  return normalise(fc);
}

/** Yahoo returns numbers as strings almost everywhere. */
export const num = (v, d = null) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const str = (v, d = null) => (v === undefined || v === null ? d : String(v));

/**
 * Yahoo positions map onto ours directly except for team defense, which Yahoo
 * calls 'DEF' in some places and 'DST' in others.
 */
export function normalisePosition(pos) {
  const p = String(pos ?? '').toUpperCase();
  if (p === 'DST' || p === 'D/ST' || p === 'DEF') return 'DEF';
  return p;
}

/** Yahoo injury status codes -> our canonical set. */
export function normaliseStatus(status) {
  const s = String(status ?? '').toUpperCase().trim();
  const map = { PROBABLE: 'P', QUESTIONABLE: 'Q', DOUBTFUL: 'D', OUT: 'O', 'IR-R': 'IR', 'IR-NR': 'IR', NFI: 'IR', PUP: 'PUP', SUSP: 'SUSP', COVID: 'COV' };
  return map[s] ?? s;
}
