import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../server/rateLimiter.js';
import { ordersFromApi, attachAmounts, adsFromApi, goodsAdsFromApi, collect } from '../server/normalize.js';
import { computeDashboard } from '../server/metrics.js';
import { evaluateAlerts } from '../server/alerts.js';
import { parseCsv, importCsv, summarizeCsv } from '../server/adapters/csv.js';
import { createMockTransport } from '../server/adapters/mock.js';
import { createClient } from '../server/temuClient.js';
import { DEFAULT_SETTINGS } from '../server/config.js';

/* ------------------------------------------------------------ rate limiter */
test('token bucket paces to the documented 20 QPS quota', async () => {
  let fakeNow = 0;
  const bucket = new TokenBucket({ capacity: 20, refillPerSec: 20, now: () => fakeNow });
  for (let i = 0; i < 20; i++) assert.equal(bucket.tryAcquire(), true, `burst token ${i}`);
  assert.equal(bucket.tryAcquire(), false, 'the 21st immediate request must be deferred');
  assert.equal(bucket.stats.denied, 1);
  fakeNow += 1000; // one second of refill
  assert.equal(bucket.tryAcquire(), true);
  assert.ok(bucket.available() <= 20);
});

/* ------------------------------------------------------------- normalisation */
test('order list pageItems normalise into dashboard records', () => {
  const orders = ordersFromApi([{
    parentOrderMap: {
      parentOrderSn: 'PO-211-21000000000000001',
      parentOrderStatus: 1,
      parentOrderTime: 1_760_000_000_000,
      siteId: 211,
      regionId: 211,
      parentShippingTime: null,
      expectShipLatestTime: 1_760_100_000_000,
      fulfillmentWarning: ['LATE_SHIPMENT_RISK'],
      orderPaymentType: 'CARD',
      parentOrderLabel: [{ name: 'ADS_ATTRIBUTED', value: 1 }],
    },
    orderList: [
      { orderSn: 'A-1', goodsId: 601099548666279, goodsName: 'Earbuds', skuId: 1, quantity: 2, orderStatus: 1 },
      { orderSn: 'A-2', goodsId: 601099548671002, goodsName: 'Tumbler', skuId: 2, quantity: 1, orderStatus: 1 },
    ],
  }]);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.itemCount, 3);
  assert.equal(o.statusLabel, 'Pending shipment');
  assert.equal(o.siteName, 'United States');
  assert.equal(o.priced, false, 'money must not be invented before the amount query');
  assert.equal(o.adsAttributed, true);
  assert.equal(o.warning[0], 'LATE_SHIPMENT_RISK');
  assert.equal(ordersFromApi([{}]).length, 0, 'rows without a parent order SN are dropped');
});

test('amount query fills GMV, settlement and deductions', () => {
  const [order] = ordersFromApi([{
    parentOrderMap: { parentOrderSn: 'PO-1', parentOrderStatus: 2, parentOrderTime: 1_760_000_000_000, siteId: 211 },
    orderList: [{ orderSn: 'A', goodsId: 1, quantity: 1 }],
  }]);
  attachAmounts(order, {
    customerPaid: {
      customerPaidTotal: { currency: 'USD', amount: 109.98 },
      productRefundsTotal: { currency: 'USD', amount: 0 },
      productTaxCustomerTotal: { currency: 'USD', amount: 7.7 },
      shippingTaxCustomerTotal: { currency: 'USD', amount: 0 },
      shippingTotalTaxIncl: { currency: 'USD', amount: 0 },
    },
    salesProceeds: {
      estimatedSettlementTotal: { currency: 'USD', amount: 89.73 },
      estimatedDeduction: { currency: 'USD', amount: 20.25 },
    },
  });
  assert.equal(order.priced, true);
  assert.equal(order.currency, 'USD');
  assert.equal(order.gmv, 109.98);
  assert.equal(order.settlement, 89.73);
  assert.equal(order.deduction, 20.25);
  assert.equal(order.tax, 7.7);
});

test('ads report parsing reads the {total:{val}} container shape', () => {
  const wrap = (v) => ({ total: { val: v }, ad: { val: v }, netTotal: { val: v }, netAd: { val: v } });
  const parsed = adsFromApi({
    summary: {
      imprCnt: wrap(50_000), clkCnt: wrap(800), cartCnt: wrap(60),
      orderPayCnt: wrap(30), orderPayAmt: wrap(1500), spend: wrap(400),
      ctr: wrap(1.6), cvr: wrap(3.75), roas: wrap(3.75), acos: wrap(26.67), transactionCost: wrap(0.5),
    },
  }, { dayLabel: '2026-10-01' });
  assert.equal(parsed.daily[0].spend, 400);
  assert.equal(parsed.daily[0].clicks, 800);
  assert.equal(parsed.daily[0].epc, 1.88);
  assert.equal(parsed.summary.roas, 3.75);
});

test('goods ads report tolerates snake/alt field names and drops rows without an id', () => {
  const rows = goodsAdsFromApi({ goodsReports: [{ goodsId: 9, goodsName: 'X', spend: 12, orderPayAmt: 40, orderPayCnt: 2, clkCnt: 30, imprCnt: 900 }, { goodsName: 'no id' }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roas, 3.33);
  assert.equal(rows[0].acos, 30);
});

/* ------------------------------------------------------------------ metrics */
function mockDashboard(overrides = {}) {
  const transport = createMockTransport({ now: () => Date.parse('2026-10-13T12:00:00Z') });
  return transport.handle('bg.order.list.v2.get', { pageSize: 40, pageNumber: 1 }).result;
}

test('the mock gateway verifies signatures exactly like the real router', async () => {
  const transport = createMockTransport();
  const log = { push() {}, list: () => [], stats: () => ({}), all: () => [] };
  const client = createClient({
    credentials: { region: 'US', qps: 50, appKey: transport.appKey, appSecret: transport.appSecret, accessToken: transport.accessToken, maxRetries: 0 },
    transport,
    log,
  });
  const good = await client.call('bg.open.accesstoken.info.get');
  assert.equal(good.ok, true);
  assert.equal(good.errorCode, 1000000);

  // a tampered sign must be rejected with the real gateway code
  const bad = await client.call('bg.open.accesstoken.info.get', {}, { retries: 0 });
  assert.equal(bad.ok, true);
  const tampered = createClient({
    credentials: { region: 'US', qps: 50, appKey: transport.appKey, appSecret: 'wrong_secret', accessToken: transport.accessToken, maxRetries: 0 },
    transport,
    log,
  });
  const res = await tampered.call('bg.open.accesstoken.info.get', {}, { retries: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 3000001);
  assert.match(res.error.meaning, /Sign invalid/);
});

test('clock skew surfaces as gateway error 3000012 instead of a silent failure', async () => {
  const transport = createMockTransport({ now: () => Date.parse('2026-10-13T12:00:00Z') });
  const log = { push() {}, list: () => [], stats: () => ({ total: 0, byCode: {} }), all: () => [] };
  const skewed = createClient({
    credentials: { region: 'US', qps: 50, appKey: transport.appKey, appSecret: transport.appSecret, accessToken: transport.accessToken, maxRetries: 0 },
    transport, log, now: () => Date.parse('2026-10-13T20:00:00Z'),
  });
  const res = await skewed.call('bg.open.accesstoken.info.get', {}, { retries: 0 });
  assert.equal(res.errorCode, 3000012);
  assert.match(res.error.hint, /NTP|expired/i);
});

test('collect() produces a dashboard worth rendering, end to end', async () => {
  // Pin the fake gateway clock to today's noon UTC. The client must share this
  // clock: the gateway rejects timestamps outside ±300s (error 3000012), which is
  // exactly what happens when a server's clock drifts.
  const now = () => Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const transport = createMockTransport({ now });
  const log = { push() {}, list: () => [], stats: () => ({ total: 0, byCode: {} }), all: () => [] };
  const client = createClient({
    credentials: { region: 'US', qps: 200, appKey: transport.appKey, appSecret: transport.appSecret, accessToken: transport.accessToken, maxRetries: 0 },
    transport, log, now,
  });

  const collected = await collect({ client, settings: {}, days: 30, amountLookups: 12, adsDays: 7, maxOrderPages: 1 });
  assert.ok(collected.orders.length > 30, 'mock account should have plenty of orders');
  assert.equal(collected.amountCoverage.priced, 12);
  assert.equal(collected.ads.daily.length, 7);
  assert.equal(collected.goods.length, 12);

  const dashboard = computeDashboard({
    collected,
    settings: { ...DEFAULT_SETTINGS, adapter: 'mock', assumedCommissionRate: 10 },
  });
  assert.match(dashboard.currency, /^[A-Z]{3}$/, 'a dominant reporting currency is chosen');
  assert.ok(dashboard.currencies.length >= 1);
  assert.equal(dashboard.mixedCurrency, dashboard.currencies.length > 1, 'multi-market accounts are flagged, not silently summed');
  assert.ok(dashboard.kpis.gmv > 0);
  assert.ok(dashboard.kpis.settlement > 0 && dashboard.kpis.settlement < dashboard.kpis.gmv, 'settlement = GMV minus deductions');
  assert.equal(dashboard.kpis.units > 0, true);
  assert.ok(dashboard.series.length >= 7, 'series covers at least the 7-day ads window');
  assert.ok(dashboard.series.some((d) => d.gmv > 0), 'priced orders land in the daily series');
  assert.ok(dashboard.series.every((d) => d.date && d.date.length === 10), 'series rows are day-keyed');
  assert.ok(dashboard.regions.length > 1, 'multiple markets');
  assert.ok(dashboard.topGoods.length > 1);
  assert.equal(dashboard.earnings.mode, 'projection');
  assert.equal(dashboard.earnings.commission, Math.round(dashboard.kpis.settlement * 0.1 * 100) / 100);
  assert.ok(dashboard.ads.roas > 0);
  assert.equal(dashboard.funnel.length, 4);
});

test('alerts fire on the failure modes they claim to catch', () => {
  const kpis = { refundRatePct: 12, agedUnshipped: 3, oldestUnshippedHours: 96, refunds: 500, orders: 100, amountCoveragePct: 40, pricedOrders: 40 };
  const dashboard = {
    currency: 'USD',
    kpis,
    ads: { spend: 100, adGmv: 150, roas: 1.5, acos: 66 },
    health: { errors: [] },
  };
  const alerts = evaluateAlerts({
    dashboard,
    tokenInfo: { expiredTime: Math.floor(Date.now() / 1000) + 3600, apiScopeList: ['bg.order.list.v2.get'], mallId: 1, regionId: 211 },
    logStats: { total: 20, errorRatePct: 25, byCode: { 4000004: 4 } },
    rate: { denied: 3, refillPerSec: 20, peakPerSec: 22 },
    settings: DEFAULT_SETTINGS,
  });
  const rules = alerts.map((a) => a.rule);
  for (const expected of ['token-expiring', 'scope-missing', 'error-rate', 'rate-limit', 'roas-low', 'acos-high', 'unshipped-aging', 'refund-rate', 'amount-coverage']) {
    assert.ok(rules.includes(expected), `expected alert ${expected} in ${rules.join(', ')}`);
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  const ranks = alerts.map((a) => rank[a.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'alerts are sorted critical -> warning -> info');
  assert.ok(alerts.some((a) => a.severity === 'critical'), 'aging fulfilment is critical');
});

test('a healthy account raises no critical alerts', () => {
  const dashboard = {
    currency: 'USD',
    kpis: { refundRatePct: 1, agedUnshipped: 0, oldestUnshippedHours: 4, unshipped: 1, refunds: 0, orders: 100, amountCoveragePct: 100, pricedOrders: 100 },
    ads: { spend: 100, adGmv: 500, roas: 5, acos: 20 },
    health: { errors: [] },
  };
  const alerts = evaluateAlerts({
    dashboard,
    tokenInfo: { expiredTime: Math.floor(Date.now() / 1000) + 86400 * 30, apiScopeList: ['bg.order.list.v2.get', 'temu.order.amount.v2.query', 'temu.searchrec.ad.reports.mall.query'] },
    logStats: { total: 30, errorRatePct: 0, byCode: {} },
    rate: { denied: 0, refillPerSec: 20, peakPerSec: 5 },
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(alerts.filter((a) => a.severity === 'critical').length, 0);
});

/* ---------------------------------------------------------------------- csv */
test('CSV parser handles quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n2,3\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'he said "hi"'], ['2', '3']]);
});

test('CSV import auto-detects affiliate export columns', () => {
  const csv = [
    'Date,Clicks,Orders,Order Amount,Commission,Country,Sub ID',
    '2026-10-01,"1,200",40,"$3,120.50","$343.26",US,pinterest',
    '2026-10-02,900,30,"$2,700.00","$297.00",CA,tiktok',
  ].join('\n');
  const dataset = importCsv(csv, { source: 'test' });
  assert.equal(dataset.rows.length, 2);
  assert.equal(dataset.currency, 'USD');
  assert.equal(dataset.rows[0].clicks, 1200, 'thousands separators are stripped');
  assert.equal(dataset.rows[0].gmv, 3120.5);
  assert.equal(dataset.rows[1].commission, 297);

  const summary = summarizeCsv(dataset);
  assert.equal(summary.totals.commission, 640.26);
  assert.equal(summary.totals.clicks, 2100);
  assert.equal(summary.daily.length, 2);
  assert.equal(summary.derived.commissionRate, 11);
  assert.ok(summary.breakdown.some((b) => b.key === 'pinterest'));
});

test('CSV import refuses files it cannot understand', () => {
  assert.throws(() => importCsv('foo,bar\n1,2'), /could not find/);
});
