/**
 * sign.js — Temu Open Platform request signing + webhook verification.
 *
 * Request signature (documented algorithm, MD5):
 *   1. Merge common params + business params into one object.
 *   2. Sort all top-level parameters ascending by key (ASCII).
 *   3. Concatenate `key` + `value` with no separator. Strings are used as-is;
 *      objects/arrays are serialised as *compact* JSON (no spaces) and kept in
 *      their original key order.
 *   4. Wrap the result with app_secret at the head and at the tail.
 *   5. MD5 it and upper-case the hex digest.
 *
 * The implementation below reproduces Temu's own published test vector
 * 4CCF219942D4180C6DDA3CE36C1B838F (see test/sign.test.js).
 *
 * Webhook verification (documented algorithm, HMAC-SHA256):
 *   sort x-tm-* params + eventData ascending, join as key=value&..., HMAC-SHA256
 *   with app_secret as key, HEX-encode, compare against x-tm-signature.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Compact JSON exactly like Python's `json.dumps(v, separators=(',', ':'))`. */
function compactJson(value) {
  if (Array.isArray(value)) return `[${value.map(compactJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).map((k) => `${JSON.stringify(k)}:${compactJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Normalise a JSON object with keys in a stable, insertion-independent order. */
export function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stableClone(value[k]);
    return out;
  }
  return value;
}

/**
 * Serialise one parameter value the way the gateway does.
 * - strings/numbers/booleans -> raw text (no quotes)
 * - objects/arrays -> compact JSON (quotes inside JSON are preserved)
 * - null/undefined -> empty string (parameter still contributes its key)
 */
export function stringifyParam(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return compactJson(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Build the pre-sign string (secret + sorted kv pairs + secret). */
export function buildSignString(appSecret, params) {
  const keys = Object.keys(params).sort();
  const parts = [];
  for (const key of keys) {
    const value = params[key];
    if (value === undefined) continue;
    if (key === 'sign') continue; // sign itself is never part of the payload to sign
    parts.push(key + stringifyParam(value));
  }
  return `${appSecret}${parts.join('')}${appSecret}`;
}

/** Compute the `sign` value for a request payload. */
export function computeSign(appSecret, params) {
  if (!appSecret) throw new Error('app_secret is required to sign a request');
  return createHash('md5').update(buildSignString(appSecret, params), 'utf8').digest('hex').toUpperCase();
}

/**
 * Attach common params + computed sign to a business payload.
 * `appSecret` is never included in the returned body.
 */
export function signedBody({ appKey, accessToken, appSecret, type, business = {}, version, now }) {
  const body = {
    app_key: appKey,
    access_token: accessToken,
    data_type: 'JSON',
    type,
    timestamp: typeof now === 'number' ? now : Math.floor(Date.now() / 1000),
    ...stableClone(business),
  };
  if (version) body.version = version;
  body.sign = computeSign(appSecret, body);
  return body;
}

/** Turn a signed body into a copy-paste curl command (secrets stay inline). */
export function toCurl(host, body) {
  const payload = JSON.stringify(body, null, 2);
  return [
    `curl -X POST '${host}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${payload}'`,
  ].join('\n');
}

const WEBHOOK_HEADERS = ['x-tm-app-key', 'x-tm-event-code', 'x-tm-timestamp', 'x-tm-ext-param'];

/**
 * Verify a Temu webhook callback.
 * @param {object} opts
 * @param {string} opts.appSecret
 * @param {object} opts.headers lower-cased header map
 * @param {string} opts.eventData decrypted eventData payload (or ciphertext you choose to sign)
 * @returns {{ok: boolean, reason?: string, expected?: string, received?: string, signString?: string}}
 */
export function verifyWebhook({ appSecret, headers, eventData }) {
  const received = headers['x-tm-signature'] || '';
  if (!received) return { ok: false, reason: 'missing x-tm-signature header' };
  if (!appSecret) return { ok: false, reason: 'app_secret not configured' };

  // Variant 1 (strict): sign exactly the headers that arrived, plus eventData.
  // Variant 2 (normalised): the four documented header params, missing ones treated
  // as empty — some HTTP stacks drop empty header values in transit, and both the
  // documented sender and our own test sender can produce either shape.
  const buildPairs = (keys) => {
    const pairs = {};
    for (const h of keys) {
      if (headers[h] !== undefined) pairs[h] = String(headers[h]);
      else if (keys === WEBHOOK_HEADERS) pairs[h] = '';
    }
    pairs.eventData = eventData ?? '';
    return pairs;
  };
  const variants = [
    { name: 'strict', keys: WEBHOOK_HEADERS.filter((h) => headers[h] !== undefined) },
    { name: 'normalised', keys: WEBHOOK_HEADERS },
  ];

  let expected = '';
  let signString = '';
  for (const variant of variants) {
    const pairs = buildPairs(variant.keys);
    const candidate = Object.keys(pairs)
      .sort()
      .map((k) => `${k}=${pairs[k]}`)
      .join('&');
    const candidateSign = createHmac('sha256', appSecret).update(candidate, 'utf8').digest('hex').toUpperCase();
    if (!expected) { expected = candidateSign; signString = candidate; }
    const a = Buffer.from(candidateSign, 'utf8');
    const b = Buffer.from(received.toUpperCase(), 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { ok: true, expected: candidateSign, received, signString: candidate, variant: variant.name };
    }
  }
  return { ok: false, expected, received, signString, reason: 'signature mismatch' };
}

/** Produce a valid webhook signature (used by the dashboard's built-in test sender). */
export function signWebhook({ appSecret, headers, eventData }) {
  const pairs = {};
  for (const h of WEBHOOK_HEADERS) if (headers[h] !== undefined) pairs[h] = String(headers[h]);
  pairs.eventData = eventData ?? '';
  const signString = Object.keys(pairs)
    .sort()
    .map((k) => `${k}=${pairs[k]}`)
    .join('&');
  return {
    signature: createHmac('sha256', appSecret).update(signString, 'utf8').digest('hex').toUpperCase(),
    signString,
  };
}

/** Mask a secret for display: keeps a 4-char head and tail. */
export function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`;
}
