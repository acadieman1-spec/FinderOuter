/**
 * adapters/live.js — transport that talks to the real Temu router.
 *
 * POST + Content-Type: application/json, exactly as documented. The endpoint
 * host is chosen by region (US / EU / Global). Only usable with credentials
 * issued by the Temu Partner Platform.
 */
export function createLiveTransport({ timeoutMs = 15_000 } = {}) {
  return {
    id: 'live',
    label: 'Live Temu Partner API',
    async send({ host, body, timeoutMs: callTimeout }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), callTimeout || timeoutMs);
      try {
        const res = await fetch(host, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          return {
            status: res.status,
            json: null,
            text,
            networkError: `non-JSON response (HTTP ${res.status})`,
          };
        }
        return { status: res.status, json, requestId: res.headers.get('x-request-id') || json?.requestId || null };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
