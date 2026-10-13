/**
 * temuClient.js — signed, rate-limited, retrying Partner API client.
 *
 * One pipeline, two transports: the mock gateway and the live router go through
 * exactly the same signing, pacing, retry and logging code, so what you see in
 * the dashboard's request log is what production will do.
 *
 * Credentials are held by the caller; app_secret is used to compute the sign and
 * is never stored on the log entries (request bodies contain no secret).
 */
import { signedBody, toCurl } from './sign.js';
import { TokenBucket } from './rateLimiter.js';
import { decodeError, isRetryable } from './errorCodes.js';
import { REGIONS } from './config.js';

let seq = 0;

export function createClient({ credentials, transport, log = createRequestLog(), now = () => Date.now() }) {
  const region = REGIONS[credentials.region] ? credentials.region : 'US';
  const host = REGIONS[region].host;
  const bucket = new TokenBucket({ capacity: credentials.qps || 20, refillPerSec: credentials.qps || 20, now });
  let requestCounter = 0;

  async function call(type, business = {}, opts = {}) {
    const id = ++seq;

    // The mock gateway's error-simulation flag is an ordinary parameter, so it has
    // to be inside the signature — appending it after signing would (correctly)
    // produce 3000001 SIGN_UNVALID. It is only ever sent to the mock transport.
    const isMock = transport.id === 'mock';
    const signable = { ...business };
    if (!isMock) delete signable.__simulate;

    const body = signedBody({
      appKey: credentials.appKey,
      accessToken: credentials.accessToken,
      appSecret: credentials.appSecret,
      type,
      business: signable,
      version: opts.version,
      now: Math.floor(now() / 1000),
    });

    const maxRetries = opts.retries ?? credentials.maxRetries ?? 3;
    const started = now();
    let waitMs = 0;
    let attempt = 0;
    let lastResponse = null;
    let lastDecoded = null;

    for (; attempt <= maxRetries; attempt++) {
      const waited = await bucket.acquire();
      waitMs += waited;
      const t0 = now();
      let raw;
      try {
        raw = await transport.send({ host, body, type, timeoutMs: credentials.requestTimeoutMs });
      } catch (networkError) {
        const latencyMs = now() - t0;
        lastResponse = { status: 0, json: null, networkError: String(networkError?.message || networkError) };
        lastDecoded = { code: 0, meaning: `Network error: ${lastResponse.networkError}`, hint: 'Check connectivity, DNS, and whether the host is reachable from this machine.', retryable: true, scope: 'transport' };
        log.push({
          id, at: started, type, host, attempt, latencyMs, waitMs, ok: false,
          errorCode: 0, error: lastResponse.networkError, body, curl: toCurl(host, body), source: transport.id,
        });
        if (attempt === maxRetries) break;
        await sleep(backoff(attempt));
        continue;
      }

      const latencyMs = now() - t0;
      const json = raw.json || {};
      const decoded = decodeError(json.errorCode, json.errorMsg);
      const ok = Boolean(json.success) && json.errorCode === 1000000 && !decoded;
      lastResponse = { ...raw, json };
      lastDecoded = decoded;

      log.push({
        id, at: started, type, host, attempt, latencyMs, waitMs,
        ok, errorCode: json.errorCode ?? null, error: json.errorMsg || (json.success ? '' : 'unknown'),
        decoded, requestId: json.requestId || raw.requestId || null,
        body, curl: toCurl(host, body), source: transport.id,
        httpStatus: raw.status,
      });

      if (ok) break;
      if (!decoded?.retryable || attempt === maxRetries) break;
      await sleep(backoff(attempt));
    }

    requestCounter++;
    const json = lastResponse?.json || {};
    return {
      ok: Boolean(json.success) && json.errorCode === 1000000,
      errorCode: json.errorCode ?? (lastResponse?.status ? lastResponse.status : null),
      errorMsg: json.errorMsg || lastResponse?.networkError || '',
      error: lastDecoded,
      result: json.result ?? null,
      raw: json,
      meta: {
        id, type, host, transport: transport.id, region,
        latencyMs: now() - started, waitMs, attempts: attempt + 1,
        sign: body.sign, timestamp: body.timestamp,
        requestId: json.requestId || null,
        requestBody: body, curl: toCurl(host, body),
      },
    };
  }

  return {
    call,
    host,
    region,
    transportId: transport.id,
    transportLabel: transport.label,
    rateLimit: () => bucket.snapshot(),
    setRate: (qps) => bucket.setRate(qps),
    requestCount: () => requestCounter,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(400 * 2 ** attempt, 4000);

export function createRequestLog(limit = 250) {
  const entries = [];
  return {
    push(entry) {
      entries.unshift(entry);
      if (entries.length > limit) entries.length = limit;
    },
    list({ type, okOnly, errorsOnly, limit = 100 } = {}) {
      let out = entries;
      if (type) out = out.filter((e) => e.type === type);
      if (okOnly) out = out.filter((e) => e.ok);
      if (errorsOnly) out = out.filter((e) => !e.ok);
      return out.slice(0, limit);
    },
    all: () => entries,
    stats() {
      const total = entries.length;
      const failed = entries.filter((e) => !e.ok).length;
      const latencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);
      const p = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0);
      const byCode = {};
      for (const e of entries) {
        if (!e.ok) byCode[e.errorCode] = (byCode[e.errorCode] || 0) + 1;
      }
      return {
        total, failed,
        errorRatePct: total ? Math.round((failed / total) * 1000) / 10 : 0,
        p50: p(0.5), p95: p(0.95), max: latencies.length ? latencies[latencies.length - 1] : 0,
        avgWaitMs: total ? Math.round(entries.reduce((s, e) => s + (e.waitMs || 0), 0) / total) : 0,
        retries: entries.filter((e) => (e.attempt || 0) > 0).length,
        byCode,
      };
    },
    clear() { entries.length = 0; },
    raw: entries,
  };
}
