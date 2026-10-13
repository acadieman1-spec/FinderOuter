/**
 * report.js — builds the single payload the dashboard UI renders.
 *
 * One build = a handful of signed API calls. Results are cached (default 60s) so
 * a browser refresh does not burn your 20 QPS quota.
 */
import { createClient, createRequestLog } from './temuClient.js';
import { createMockTransport, MOCK_APP_KEY, MOCK_APP_SECRET, MOCK_ACCESS_TOKEN, DASHBOARD_SCOPES } from './adapters/mock.js';
import { createLiveTransport } from './adapters/live.js';
import { collect } from './normalize.js';
import { computeDashboard, summarizeCsv } from './metrics.js';
import { evaluateAlerts } from './alerts.js';
import { store } from './store.js';
import { REGIONS, ADAPTERS } from './config.js';
import { signedBody, buildSignString, computeSign } from './sign.js';

const cacheMs = () => Number(process.env.REPORT_CACHE_MS ?? 60_000);

export function createEngine() {
  const log = createRequestLog();
  let cache = { at: 0, key: '', payload: null };
  let lastRate = null;

  function resolveCredentials() {
    const settings = store.settings;
    const creds = store.credentials();
    const mode = creds.adapter;

    if (mode === 'csv') {
      return { mode, settings, creds, client: null, configured: true, usingMockCredentials: false };
    }

    if (mode === 'mock') {
      const usingMockCredentials = !creds.appSecret || !creds.accessToken;
      return {
        mode, settings, client: null, usingMockCredentials, configured: true,
        creds: {
          ...creds,
          appKey: creds.appKey || MOCK_APP_KEY,
          appSecret: creds.appSecret || MOCK_APP_SECRET,
          accessToken: creds.accessToken || MOCK_ACCESS_TOKEN,
        },
      };
    }

    const configured = Boolean(creds.appKey && creds.appSecret && creds.accessToken);
    return { mode, settings, creds, client: null, configured, usingMockCredentials: false };
  }

  function transportFor(ctx) {
    if (ctx.mode === 'mock') {
      return createMockTransport({ region: ctx.creds.region, now: () => Date.now() });
    }
    if (ctx.mode === 'partner') return createLiveTransport({ timeoutMs: ctx.creds.requestTimeoutMs });
    return null;
  }

  function makeClient(ctx) {
    const transport = transportFor(ctx);
    if (!transport) return null;
    return createClient({ credentials: ctx.creds, transport, log });
  }

  async function build({ force = false, days = 30, amountLookups = 45, adsDays = 14, onProgress } = {}) {
    const ctx = resolveCredentials();
    const key = [ctx.mode, ctx.creds?.region, ctx.creds?.appKey, amountLookups, adsDays, days, store.csvDataset?.importedAt || ''].join('|');
    if (!force && cache.payload && cache.key === key && Date.now() - cache.at < cacheMs()) {
      return { ...cache.payload, cached: true, cacheAgeMs: Date.now() - cache.at };
    }

    let collected = { orders: [], ads: { summary: null, daily: [] }, adsGoods: [], goods: [], tokenInfo: null, errors: [], timings: {} };
    let client = null;

    if (ctx.mode === 'csv') {
      if (!store.csvDataset) {
        collected.errors.push({
          step: 'csv', errorCode: 'NO_DATA',
          errorMsg: 'No CSV imported yet. Use "Import export" and paste your affiliate/partner CSV.',
        });
      } else {
        const summary = summarizeCsv(store.csvDataset);
        collected.ads = { summary: null, daily: [] };
        // CSV rows become the "orders" surface so every panel keeps working.
        collected.orders = (store.csvDataset.rows || []).map((r, i) => ({
          parentOrderSn: r.orderId || `CSV-${i + 1}`,
          status: 3,
          statusLabel: r.status || 'Imported',
          siteName: r.country || 'Imported export',
          created: r.ts,
          itemCount: r.orders || 1,
          items: r.productName ? [{ goodsId: `csv-${i}`, goodsName: r.productName, quantity: r.orders || 1 }] : [],
          currency: store.csvDataset.currency,
          gmv: r.gmv,
          settlement: r.commission,
          deduction: 0,
          refundedTotal: 0,
          priced: true,
          source: 'csv',
        }));
        collected.amountCoverage = { priced: collected.orders.length, total: collected.orders.length };
        collected.csvSummary = summary;
      }
    } else if (!ctx.configured) {
      collected.errors.push({
        step: 'config', errorCode: 'NOT_CONFIGURED',
        errorMsg: 'Adapter is "partner" but app_key, app_secret and access_token are not all set.',
      });
    } else {
      client = makeClient(ctx);
      collected = await collect({
        client,
        settings: { ...store.settings, ...ctx.creds, assumedCommissionRate: store.settings.assumedCommissionRate },
        days, amountLookups, adsDays,
        onProgress,
      });
    }

    const settingsForMetrics = {
      ...store.settings,
      ...ctx.creds,
      adapter: ctx.mode,
      csvDataset: store.csvDataset,
    };
    const dashboard = computeDashboard({ collected, settings: settingsForMetrics });
    const alerts = evaluateAlerts({
      dashboard,
      tokenInfo: collected.tokenInfo,
      logStats: log.stats(),
      rate: log._rate || { denied: 0, refillPerSec: store.settings.qps, peakPerSec: 0 },
      settings: store.settings,
    });
    for (const a of alerts) store.recordAlert(a);

    const payload = {
      cached: false,
      builtAt: new Date().toISOString(),
      adapter: {
        id: ctx.mode,
        label: ADAPTERS[ctx.mode] || ctx.mode,
        configured: ctx.configured,
        usingMockCredentials: ctx.usingMockCredentials,
        region: ctx.creds?.region || store.settings.region,
        host: REGIONS[ctx.creds?.region || store.settings.region]?.host,
        transport: client?.transportLabel || (ctx.mode === 'csv' ? 'CSV import' : '—'),
        note: ctx.mode === 'csv'
          ? 'Affiliate exports have no public API; numbers come from the file you imported.'
          : ctx.mode === 'mock'
            ? 'No credentials, no network: synthetic orders/ads through the real signing + envelope path.'
            : 'Live calls to the Temu Partner API using your credentials.',
      },
      dashboard,
      alerts,
      settings: store.publicSettings(),
      requests: { stats: log.stats(), recent: log.list({ limit: 40 }), rate: client ? client.rateLimit() : null },
    };
    if (client) lastRate = client.rateLimit();

    cache = { at: Date.now(), key, payload };
    return payload;
  }

  /**
   * Build (but do not send) a signed request. Powers the API explorer: you see
   * the exact pre-sign string, the MD5 sign and the curl, then optionally fire it.
   */
  function previewRequest({ type, params = {}, region }) {
    const ctx = resolveCredentials();
    const creds = ctx.creds || { region: store.settings.region };
    const regionKey = REGIONS[region] ? region : (REGIONS[creds.region] ? creds.region : 'US');
    const body = signedBody({
      appKey: creds.appKey || '(app_key)',
      accessToken: creds.accessToken || '(access_token)',
      appSecret: creds.appSecret || '(app_secret)',
      type,
      business: params,
    });
    return {
      host: REGIONS[regionKey].host,
      region: regionKey,
      body,
      signString: buildSignString(creds.appSecret || '(app_secret)', body),
      sign: computeSign(creds.appSecret || '(app_secret)', body),
    };
  }

  async function sendRaw({ type, params = {}, region }) {
    const ctx = resolveCredentials();
    if (ctx.mode === 'csv') throw new Error('the CSV adapter has no API to call');
    const creds = { ...ctx.creds, region: REGIONS[region] ? region : ctx.creds?.region };
    const client = createClient({ credentials: creds, transport: transportFor({ ...ctx, creds }), log });
    const res = await client.call(type, params);
    return { ...res, rate: client.rateLimit() };
  }

  return { build, previewRequest, sendRaw, log, getLastRate: () => lastRate, invalidate: () => { cache = { at: 0, key: '', payload: null }; } };
}

export { DASHBOARD_SCOPES };
