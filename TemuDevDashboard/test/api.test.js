/**
 * api.test.js — end-to-end HTTP tests against the real server (mock adapter).
 * Runs on an ephemeral port with DATA_DIR pointed at a temp folder so the test
 * never touches your saved settings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'temu-dash-test-'));
process.env.REPORT_CACHE_MS = '0';

const { createDashboardServer } = await import('../server/index.js');

let server;
let base;

test.before(async () => {
  server = createDashboardServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

const get = async (path, init) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { res, json, text };
};

const post = (path, body, headers = { 'x-dashboard': '1' }) =>
  get(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('serves the dashboard shell', async () => {
  const { res, text } = await get('/');
  assert.equal(res.status, 200);
  assert.match(text, /Temu Partner API — developer dashboard/);
  assert.match(text, /\/app\.js/);

  const css = await get('/styles.css');
  assert.equal(css.res.status, 200);
  const js = await get('/app.js');
  assert.match(js.text, /refreshWithProgress/);
});

test('health and bootstrap state', async () => {
  const health = await get('/api/health');
  assert.equal(health.json.ok, true);

  const { json } = await get('/api/state');
  assert.equal(json.settings.adapter, 'mock');
  assert.ok(json.adapters.some((a) => a.id === 'partner'));
  assert.equal(json.regions.length, 3);
  assert.ok(json.catalog.endpoints > 100, 'endpoint catalogue is loaded');
  assert.equal(json.gatewayErrors['4000004'].msg, 'RATE_LIMIT_EXCEED_EXCEPTION');
  assert.ok(json.dashboardScopes.includes('bg.order.list.v2.get'));
});

test('the full catalogue is served with params and response examples', async () => {
  const { json } = await get('/api/catalog');
  const order = json.endpoints.find((e) => e.name === 'bg.order.list.v2.get');
  assert.ok(order, 'order list endpoint present');
  assert.ok(order.params.some((p) => p.name === 'createAfter'));
  assert.ok(order.errors.some((e) => e.code === 140020001));
  assert.match(order.responseExample, /pageItems/);
  assert.equal(json.gateway.hosts.US, 'https://openapi-b-us.temu.com/openapi/router');
});

test('report renders KPIs, alerts and request stats', async () => {
  const { json } = await post('/api/report/refresh', { amountLookups: 8, adsDays: 5, days: 20 });
  assert.equal(json.adapter.id, 'mock');
  assert.ok(json.dashboard.kpis.orders > 0);
  assert.ok(json.dashboard.kpis.gmv > 0);
  assert.equal(json.dashboard.kpis.pricedOrders, 8);
  assert.ok(json.dashboard.ads.spend > 0);
  assert.ok(json.dashboard.series.length >= 5);
  assert.ok(Array.isArray(json.dashboard.topGoods));
  assert.ok(json.alerts.some((a) => a.rule === 'amount-coverage'), 'coverage alert is always honest about partial data');
  assert.ok(json.requests.stats.total > 0);
  assert.ok(json.requests.recent.length > 0);
  assert.ok(json.requests.recent.every((r) => r.body && !JSON.stringify(r.body).includes('app_secret')));
});

test('report is cached so browser refreshes do not burn quota', async () => {
  process.env.REPORT_CACHE_MS = '60000';
  await post('/api/report/refresh', { amountLookups: 4, adsDays: 3 });
  const { json } = await get('/api/report');
  assert.equal(json.cached, true);
  process.env.REPORT_CACHE_MS = '0';
});

test('playground builds a correctly signed request without sending it', async () => {
  const { json } = await post('/api/playground', { type: 'bg.order.list.v2.get', params: { pageSize: 5, pageNumber: 1 } });
  const { preview } = json;
  assert.equal(preview.body.app_key, 'mock_app_key_0001');
  assert.equal(preview.body.data_type, 'JSON');
  assert.match(preview.sign, /^[0-9A-F]{32}$/);
  assert.match(preview.signString, /^mock_app_secret_0001/);
  assert.ok(preview.signString.endsWith('mock_app_secret_0001'));
  assert.match(preview.signString, /pageSize5/);
  assert.equal(json.result, undefined, 'preview must not call the API');
});

test('playground can send for real and reports the gateway verdict', async () => {
  const { json } = await post('/api/playground', {
    type: 'temu.order.amount.v2.query',
    params: { parentOrderSn: 'PO-211-1' },
    send: true,
  });
  assert.ok([1000000, 140020013].includes(json.result.errorCode), 'either success or the documented "not passed in" error');
  assert.ok(json.result.meta.latencyMs >= 0);
  assert.match(json.result.meta.curl, /curl -X POST/);
});

test('error simulation exercises the retry + decoder path', async () => {
  const rate = await post('/api/playground', { type: 'bg.open.accesstoken.info.get', params: {}, send: true, simulate: 'RATE_LIMIT' });
  assert.equal(rate.json.result.errorCode, 4000004);
  assert.match(rate.json.result.error.meaning, /Rate limit/);
  assert.equal(rate.json.result.error.retryable, true);

  const scope = await post('/api/playground', { type: 'bg.order.list.v2.get', params: {}, send: true, simulate: 'SCOPE' });
  assert.equal(scope.json.result.errorCode, 3000032);
  assert.equal(scope.json.result.error.retryable, false);
  assert.match(scope.json.result.error.hint, /seller/i);
});

test('sign endpoint exposes the pre-sign string for debugging', async () => {
  const { json } = await post('/api/sign', { appSecret: 'SECRET', params: { b: '2', a: '1' } });
  assert.equal(json.signString, 'SECRETa1b2SECRET');
});

test('webhook receiver verifies HMAC and rejects tampering', async () => {
  const sample = await post('/api/webhook/sample', { eventCode: 'bg_order_status_change_event', eventData: { orderSn: 'PO-1', status: 2 } });
  assert.match(sample.json.signature, /^[0-9A-F]{64}$/);

  const delivered = await post('/webhook/temu', { eventData: sample.json.eventData }, {
    'x-dashboard': '1',
    'x-tm-app-key': sample.json.headers['x-tm-app-key'],
    'x-tm-event-code': sample.json.headers['x-tm-event-code'],
    'x-tm-timestamp': sample.json.headers['x-tm-timestamp'],
    'x-tm-signature': sample.json.signature,
  });
  assert.equal(delivered.res.status, 200);
  assert.equal(delivered.json.received, true);

  const tampered = await post('/webhook/temu', { eventData: '{"orderSn":"ATTACKER"}' }, {
    'x-dashboard': '1',
    'x-tm-app-key': sample.json.headers['x-tm-app-key'],
    'x-tm-event-code': sample.json.headers['x-tm-event-code'],
    'x-tm-timestamp': sample.json.headers['x-tm-timestamp'],
    'x-tm-signature': sample.json.signature,
  });
  assert.equal(tampered.res.status, 401);
  assert.equal(tampered.json.received, false);

  const inbox = await get('/api/webhooks');
  assert.ok(inbox.json.inbox.length >= 2);
  assert.equal(inbox.json.inbox[0].verified, false, 'newest (tampered) event is flagged');
  assert.equal(inbox.json.inbox[1].verified, true);
  assert.equal(inbox.json.inbox[1].decoded.orderSn, 'PO-1', 'plain-JSON eventData is parsed for display');
  assert.ok(inbox.json.inbox[1].expected && inbox.json.inbox[1].received, 'expected vs received signature is kept for debugging');
});

test('CSV import switches the adapter and feeds the dashboard', async () => {
  const csv = 'date,clicks,orders,sales,commission\n2026-10-01,1000,40,3000,330\n2026-10-02,800,30,2400,264';
  const imported = await post('/api/csv/import', { text: csv });
  assert.equal(imported.json.imported.rows, 2);
  assert.equal(imported.json.summary.totals.commission, 594);

  await post('/api/settings', { adapter: 'csv' });
  const report = await post('/api/report/refresh', {});
  assert.equal(report.json.adapter.id, 'csv');
  assert.equal(report.json.dashboard.earnings.mode, 'imported');
  assert.equal(report.json.dashboard.earnings.commission, 594);

  const dataset = await get('/api/csv');
  assert.equal(dataset.json.dataset.rows, 2);

  await post('/api/settings', { adapter: 'mock' });
  assert.equal((await post('/api/report/refresh', {})).json.adapter.id, 'mock');
});

test('mutating routes require the dashboard header', async () => {
  const blocked = await post('/api/settings', { adapter: 'mock' }, {});
  assert.equal(blocked.res.status, 403);
  const blockedCsv = await post('/api/csv/import', { text: 'x' }, {});
  assert.equal(blockedCsv.res.status, 403);
});

test('settings reject nonsense and never echo secrets', async () => {
  const bad = await post('/api/settings', { adapter: 'yes-please' });
  assert.equal(bad.res.status, 400);

  const saved = await post('/api/settings', { appKey: 'app_12345678', appSecret: 'super-secret-value', accessToken: 'token_abcdefgh' });
  assert.equal(saved.json.settings.appKey, 'app_12345678');
  assert.equal(saved.json.settings.appSecret, '••••••••');
  assert.match(saved.json.settings.accessToken, /^toke…efgh$/);
  assert.ok(!JSON.stringify(saved.json).includes('super-secret-value'));
});
