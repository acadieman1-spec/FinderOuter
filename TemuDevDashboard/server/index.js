/**
 * index.js — HTTP server for the Temu Partner API developer dashboard.
 *
 * Zero runtime dependencies: node:http + node:crypto + fetch (Node 18+).
 * Binds 0.0.0.0 so it works behind a sandbox/proxy preview as well as locally.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { PUBLIC_DIR, HOST, PORT, REGIONS, ADAPTERS } from './config.js';
import { store } from './store.js';
import { createEngine, DASHBOARD_SCOPES } from './report.js';
import { importCsv, summarizeCsv } from './adapters/csv.js';
import { verifyWebhook, signWebhook, computeSign, buildSignString } from './sign.js';
import { GATEWAY_ERRORS } from './errorCodes.js';
import { MOCK_APP_SECRET } from './adapters/mock.js';
import { fileURLToPath } from 'node:url';

const engine = createEngine();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const json = (res, status, body, extra = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extra,
  });
  res.end(payload);
};

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

/** Mutating routes require the dashboard's own header (blocks blind CSRF). */
function requireDashboardHeader(req) {
  return req.headers['x-dashboard'] === '1';
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const info = await stat(file);
    if (info.isDirectory()) return notFound(res);
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': rel.endsWith('.html') ? 'no-store' : 'public, max-age=60',
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

const notFound = (res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404 — not found');
};

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), node: process.version, adapter: store.settings.adapter });
  }

  if (p === '/api/state' && req.method === 'GET') {
    const catalog = await loadCatalog();
    return json(res, 200, {
      settings: store.publicSettings(),
      adapters: Object.entries(ADAPTERS).map(([id, label]) => ({ id, label })),
      regions: Object.entries(REGIONS).map(([id, r]) => ({ id, label: r.label, host: r.host, currency: r.currency })),
      gatewayErrors: GATEWAY_ERRORS,
      dashboardScopes: DASHBOARD_SCOPES,
      catalog: {
        endpoints: catalog.endpoints.length,
        categories: catalog.categories,
        gateway: catalog.gateway,
        generatedAt: catalog.generatedAt,
        source: catalog.source,
      },
      csv: store.csvDataset ? { rows: store.csvDataset.rows.length, currency: store.csvDataset.currency, importedAt: store.csvDataset.importedAt, columns: store.csvDataset.columns } : null,
      secretsInMemory: Boolean(store.settings.appSecret || store.settings.accessToken),
      persistedSecrets: store.publicSettings().secretsPersisted,
    });
  }

  if (p === '/api/catalog' && req.method === 'GET') {
    return json(res, 200, await loadCatalog());
  }

  if (p === '/api/settings' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    const patch = await readBody(req);
    if (patch.adapter && !ADAPTERS[patch.adapter]) return json(res, 400, { error: `unknown adapter: ${patch.adapter}` });
    if (patch.region && !REGIONS[String(patch.region).toUpperCase()]) return json(res, 400, { error: `unknown region: ${patch.region}` });
    if (patch.adapter) patch.adapter = String(patch.adapter).toLowerCase();
    if (patch.region) patch.region = String(patch.region).toUpperCase();
    store.update(patch);
    engine.invalidate();
    return json(res, 200, { settings: store.publicSettings() });
  }

  if (p === '/api/settings/reset' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    store.reset();
    engine.invalidate();
    return json(res, 200, { settings: store.publicSettings() });
  }

  if (p === '/api/report' && req.method === 'GET') {
    const payload = await engine.build({
      force: q.get('force') === '1',
      days: Number(q.get('days') || store.settings.days),
      amountLookups: Number(q.get('amountLookups') || store.settings.amountLookups),
      adsDays: Number(q.get('adsDays') || store.settings.adsDays),
    });
    return json(res, 200, payload);
  }

  if (p === '/api/report/stream' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await engine.build({
        force: q.get('force') === '1',
        days: Number(q.get('days') || store.settings.days),
        amountLookups: Number(q.get('amountLookups') || store.settings.amountLookups),
        adsDays: Number(q.get('adsDays') || store.settings.adsDays),
        onProgress: (ev) => send('progress', ev),
      }).then((payload) => send('report', payload));
      send('done', { ok: true });
    } catch (err) {
      send('error', { message: String(err?.message || err) });
    }
    return res.end();
  }

  if (p === '/api/report/refresh' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    const body = await readBody(req);
    // Sticky window: what you ask for once keeps applying on plain reloads, which
    // keeps the cache key stable and protects the 20 QPS quota.
    const patch = {};
    for (const k of ['days', 'amountLookups', 'adsDays']) {
      if (body[k] !== undefined && Number.isFinite(Number(body[k]))) patch[k] = Number(body[k]);
    }
    if (Object.keys(patch).length) store.update(patch);
    // Resolve every window value from the store so the cache key stays identical
    // between an explicit refresh and a later plain reload.
    const payload = await engine.build({
      force: true,
      days: store.settings.days,
      amountLookups: store.settings.amountLookups,
      adsDays: store.settings.adsDays,
    });
    return json(res, 200, payload);
  }

  if (p === '/api/requests' && req.method === 'GET') {
    return json(res, 200, {
      stats: engine.log.stats(),
      rate: engine.getLastRate(),
      entries: engine.log.list({
        limit: Number(q.get('limit') || 50),
        type: q.get('type') || undefined,
        errorsOnly: q.get('errorsOnly') === '1',
      }),
    });
  }

  if (p === '/api/requests/clear' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    engine.log.clear();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/playground' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    const body = await readBody(req);
    const type = body.type;
    if (!type) return json(res, 400, { error: 'type is required' });
    const params = { ...(body.params || {}) };
    if (body.simulate) params.__simulate = body.simulate;
    const preview = engine.previewRequest({ type, params, region: body.region });
    if (!body.send) return json(res, 200, { preview });
    const started = Date.now();
    const res2 = await engine.sendRaw({ type, params, region: body.region });
    return json(res, 200, { preview: { ...preview, sign: res2.meta.sign, body: res2.meta.requestBody }, result: res2, elapsedMs: Date.now() - started });
  }

  if (p === '/api/sign' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    const body = await readBody(req);
    const secret = body.appSecret || store.settings.appSecret || MOCK_APP_SECRET;
    const params = body.params || {};
    return json(res, 200, {
      sign: computeSign(secret, params),
      signString: buildSignString(secret, params),
      note: 'Sorted keys, values concatenated, app_secret wrapped head+tail, MD5, upper-case.',
    });
  }

  if (p === '/api/csv/import' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    const body = await readBody(req);
    if (!body.text) return json(res, 400, { error: 'text is required' });
    try {
      const dataset = importCsv(body.text, { source: body.source || 'pasted' });
      store.setCsvDataset(dataset);
      engine.invalidate();
      const summary = summarizeCsv(dataset);
      return json(res, 200, { imported: { rows: dataset.rows.length, currency: dataset.currency, columns: dataset.columns, unmapped: dataset.unmapped }, summary });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  }

  if (p === '/api/csv' && req.method === 'GET') {
    if (!store.csvDataset) return json(res, 200, { dataset: null });
    return json(res, 200, {
      dataset: { rows: store.csvDataset.rows.length, currency: store.csvDataset.currency, importedAt: store.csvDataset.importedAt, columns: store.csvDataset.columns, unmapped: store.csvDataset.unmapped, map: store.csvDataset.map },
      summary: summarizeCsv(store.csvDataset),
    });
  }

  if (p === '/api/webhooks' && req.method === 'GET') return json(res, 200, { inbox: store.webhookInbox });

  if (p === '/api/webhooks/clear' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    store.webhookInbox = [];
    store.persist();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/webhook/sample' && req.method === 'POST') {
    if (!requireDashboardHeader(req)) return json(res, 403, { error: 'missing x-dashboard header' });
    const body = await readBody(req);
    const secret = store.settings.appSecret || MOCK_APP_SECRET;
    const eventCode = body.eventCode || 'bg_order_status_change_event';
    const eventData = JSON.stringify(body.eventData || { orderSn: 'PO-211-21000000000000001', status: 1 });
    const headers = {
      'x-tm-app-key': store.settings.appKey || 'mock_app_key_0001',
      'x-tm-event-code': eventCode,
      'x-tm-timestamp': String(Date.now()),
      'x-tm-ext-param': body.extParam || '',
    };
    const { signature, signString } = signWebhook({ appSecret: secret, headers, eventData });
    const entry = {
      at: Date.now(), eventCode, eventData, headers: { ...headers, 'x-tm-signature': signature },
      verified: true, signString, source: 'dashboard-test-sender',
    };
    store.pushWebhook(entry);
    return json(res, 200, { delivered: true, signature, signString, headers: entry.headers, eventData, note: 'POST this to your webhook path to test your own verifier.' });
  }

  return json(res, 404, { error: `no route for ${req.method} ${p}` });
}

/** Inbound webhook receiver: verifies the HMAC-SHA256 signature before trusting it. */
async function handleWebhook(req, res) {
  const body = await readBody(req, 1024 * 1024);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const eventData = typeof body.eventData === 'string' ? body.eventData : JSON.stringify(body.eventData ?? '');
  const secret = store.settings.appSecret || MOCK_APP_SECRET;
  const verdict = verifyWebhook({ appSecret: secret, headers, eventData });

  // Temu documents eventData as encrypted without publishing the algorithm, so we
  // cannot decrypt a production callback. We *can* show something useful: parse it
  // when the sender (your own test tool, or a plain-JSON integration) sends JSON,
  // otherwise try base64 -> JSON, otherwise keep the raw payload.
  let decoded = null;
  try {
    decoded = JSON.parse(eventData);
  } catch {
    try {
      decoded = JSON.parse(Buffer.from(eventData, 'base64').toString('utf8'));
    } catch { /* opaque ciphertext — keep raw */ }
  }

  const entry = {
    at: Date.now(),
    eventCode: headers['x-tm-event-code'] || '',
    appKey: headers['x-tm-app-key'] || '',
    timestamp: headers['x-tm-timestamp'] || '',
    extParam: headers['x-tm-ext-param'] || '',
    eventData,
    decoded,
    verified: verdict.ok,
    reason: verdict.reason || null,
    expected: verdict.expected,
    received: verdict.received,
    source: 'inbound',
  };
  store.pushWebhook(entry);
  return json(res, verdict.ok ? 200 : 401, { received: verdict.ok, reason: verdict.reason || 'signature verified' });
}

let catalogCache = null;
async function loadCatalog() {
  if (catalogCache) return catalogCache;
  const raw = await readFile(join(PUBLIC_DIR, 'data', 'endpoints.json'), 'utf8');
  catalogCache = JSON.parse(raw);
  return catalogCache;
}

export function createDashboardServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,x-dashboard',
        });
        return res.end();
      }
      if (url.pathname === '/webhook/temu' && req.method === 'POST') return await handleWebhook(req, res);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET') {
        const asFile = join(PUBLIC_DIR, url.pathname.replace(/^\/+/, ''));
        try {
          await stat(asFile);
          return await serveStatic(req, res, url.pathname);
        } catch {
          return await serveStatic(req, res, '/index.html'); // SPA fallback
        }
      }
      return notFound(res);
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) });
    }
  });
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createDashboardServer();
  server.listen(PORT, HOST, () => {
    console.log(`Temu dev dashboard → http://${HOST}:${PORT}  (adapter: ${store.settings.adapter}, region: ${store.settings.region})`);
    console.log('No credentials needed: adapter "mock" serves synthetic data through the real signing path.');
  });
}
