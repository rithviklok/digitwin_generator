// ===================================================================
// ids.js -- cityId slugs and access tokens. The slug doubles as the
// privacy boundary for static file URLs (/files is not gated by the
// access token, see app.js) so it must be unguessable, not just unique
// -- a sequential or purely-derived id would let someone enumerate
// other people's private cities.
// ===================================================================
import { timingSafeEqual } from 'node:crypto';
import { nanoid, customAlphabet } from 'nanoid';

const CITY_ID_RE = /^[a-z0-9-]{1,64}$/;
const slugSuffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * A new city's id: a human-readable prefix (from the display name, or
 * plain "city" if it slugifies to nothing, e.g. a non-Latin name) plus a
 * random suffix that's always present -- the prefix is a courtesy for
 * anyone reading logs/URLs, the suffix is what actually makes it
 * unguessable and prevents collisions between two people naming their
 * city the same thing.
 */
export function newCityId(displayName) {
  const base = slugify(displayName) || 'city';
  const id = `${base}-${slugSuffix()}`;
  if (!CITY_ID_RE.test(id)) throw new Error(`generated cityId "${id}" failed validation -- this should be unreachable`);
  return id;
}

/** Re-validate a cityId that's about to be used in a filesystem path or CLI arg -- never trust one from a URL param without this, even though we generated it ourselves. */
export function assertValidCityId(cityId) {
  if (!CITY_ID_RE.test(cityId)) throw new Error(`invalid cityId "${cityId}"`);
}

/** @returns {string} a city's private access key: 32 URL-safe characters, ~190 bits */
export function newAccessToken() {
  return nanoid(32);
}

/**
 * Whether a token from a request matches a city's stored access token.
 * Compared in constant time, like the admin token (adminAuth.js): `!==`
 * stops at the first differing character, which in principle lets response
 * timing reveal a token one character at a time. Anything that isn't a
 * non-empty string (a missing ?t=, or ?t=a&t=b arriving as an array) never matches.
 * @param {string} stored @param {unknown} provided
 * @returns {boolean}
 */
export function accessTokenMatches(stored, provided) {
  if (typeof provided !== 'string' || provided.length === 0 || typeof stored !== 'string') return false;
  const a = Buffer.from(provided), b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b); // equal lengths first: timingSafeEqual throws on unequal ones
}
