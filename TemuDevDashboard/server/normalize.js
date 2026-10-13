/**
 * normalize.js — one collection pipeline for both transports.
 *
 * Real-world API economics matter here: the order list endpoint returns no money
 * amounts, so GMV comes from `temu.order.amount.v2.query` — one call per parent
 * order. The dashboard therefore fetches amounts for the newest N orders and
 * reports coverage honestly instead of inventing totals.
 */
import { ORDER_STATUS, SITES } from './fixtures.js';

export const DASHBOARD_CALLS = {
  token: 'bg.open.accesstoken.info.get',
  orders: 'bg.order.list.v2.get',
  amounts: 'temu.order.amount.v2.query',
  adsMall: 'temu.searchrec.ad.reports.mall.query',
  adsGoods: 'temu.searchrec.ad.reports.goods.query',
  goods: 'bg.local.goods.list.query',
};

export function statusLabel(status) {
  return ORDER_STATUS[status] || `Status ${status}`;
}

export function siteLabel(siteId, regionId) {
  const s = SITES.find((x) => x.siteId === Number(siteId) || x.regionId === Number(regionId));
  return s ? s.label : `Site ${siteId ?? regionId ?? '?'}`;
}

/** Raw order-list pageItems -> internal order records (no money yet). */
export function ordersFromApi(pageItems = []) {
  return pageItems.map((page) => {
    const p = page.parentOrderMap || {};
    const lines = page.orderList || [];
    return {
      parentOrderSn: p.parentOrderSn,
      status: p.parentOrderStatus,
      statusLabel: statusLabel(p.parentOrderStatus),
      siteId: p.siteId,
      regionId: p.regionId,
      siteName: siteLabel(p.siteId, p.regionId),
      created: Number(p.parentOrderTime) || null,
      updated: Number(p.updateTime) || null,
      shippedAt: Number(p.parentShippingTime) || null,
      expectShipLatestTime: Number(p.expectShipLatestTime) || null,
      warning: p.fulfillmentWarning || [],
      paymentType: p.orderPaymentType || '',
      labels: (p.parentOrderLabel || []).map((l) => l?.name).filter(Boolean),
      adsAttributed: (p.parentOrderLabel || []).some((l) => String(l?.name || '').includes('ADS')),
      hasShippingFee: Boolean(p.hasShippingFee),
      itemCount: lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0),
      items: lines.map((l) => ({
        orderSn: l.orderSn,
        goodsId: l.goodsId,
        goodsName: l.goodsName || l.originalGoodsName || `Goods ${l.goodsId}`,
        skuId: l.skuId,
        spec: l.spec,
        quantity: Number(l.quantity) || 0,
        orderStatus: l.orderStatus,
        fulfillmentType: l.fulfillmentType,
        thumbUrl: l.thumbUrl,
        category: null,
      })),
      currency: null,
      gmv: null,
      settlement: null,
      deduction: null,
      refundedTotal: null,
      priced: false,
      source: 'partner-api',
    };
  }).filter((o) => o.parentOrderSn);
}

/** Merge a temu.order.amount.v2.query result into an order record. */
export function attachAmounts(order, result) {
  if (!order || !result) return order;
  const paid = result.customerPaid || {};
  const proceeds = result.salesProceeds || {};
  const num = (cell) => (cell && typeof cell === 'object' ? Number(cell.amount) || 0 : Number(cell) || 0);
  const cur = (cell) => (cell && typeof cell === 'object' ? cell.currency : null);

  const gmv = num(paid.customerPaidTotal ?? paid.retailPriceTotalTaxIncl);
  const settlement = num(proceeds.estimatedSettlementTotal ?? proceeds.basePriceDiscountedTotal);
  const refunds = num(paid.productRefundsTotal);

  order.currency = cur(paid.customerPaidTotal) || order.currency || 'USD';
  order.gmv = round2(gmv);
  order.settlement = round2(settlement);
  order.deduction = round2(num(proceeds.estimatedDeduction) || gmv - settlement);
  order.refundedTotal = round2(refunds);
  order.tax = round2(num(paid.productTaxCustomerTotal) + num(paid.shippingTaxCustomerTotal));
  order.shipping = round2(num(paid.shippingTotalTaxIncl ?? paid.shippingTotalTaxExcl));
  order.priced = true;
  return order;
}

/** Ad reports -> { summary, daily[] } with readable numbers. */
export function adsFromApi(result, { dayLabel } = {}) {
  if (!result) return { summary: null, daily: [] };
  const summary = result.summary || {};
  const pick = (metric) => {
    const m = summary[metric];
    if (m === undefined || m === null) return 0;
    if (typeof m === 'number') return m;
    return Number(m.total?.val ?? m.total ?? 0) || 0;
  };
  const flat = { ...summary };

  const row = {
    date: dayLabel || (flat.date ? new Date(Number(flat.date) * 1000).toISOString().slice(0, 10) : null),
    impressions: pick('imprCnt'),
    clicks: pick('clkCnt'),
    carts: pick('cartCnt'),
    orders: pick('orderPayCnt'),
    adGmv: pick('orderPayAmt'),
    spend: pick('spend'),
    ctr: pick('ctr'),
    cvr: pick('cvr'),
    roas: pick('roas'),
    acos: pick('acos'),
    cpc: pick('transactionCost'),
  };
  row.epc = row.clicks ? round2(row.adGmv / row.clicks) : 0;

  return {
    summary: {
      impressions: row.impressions, clicks: row.clicks, carts: row.carts, orders: row.orders,
      adGmv: row.adGmv, spend: row.spend, ctr: row.ctr || pct(row.clicks, row.impressions),
      cvr: row.cvr || pct(row.orders, row.clicks), roas: row.roas || ratio(row.adGmv, row.spend),
      acos: row.acos || pct(row.spend, row.adGmv), cpc: row.cpc || ratio(row.spend, row.clicks),
      cpm: row.impressions ? round2((row.spend / row.impressions) * 1000) : 0,
    },
    daily: [row],
  };
}

/** Goods ad report rows -> internal shape. */
export function goodsAdsFromApi(result) {
  const rows = result?.goodsReports || result?.goodsList || result?.pageItems || [];
  return rows.map((g) => ({
    goodsId: g.goodsId,
    goodsName: g.goodsName || g.originalGoodsName || `Goods ${g.goodsId}`,
    spend: round2(Number(g.spend ?? g.adSpend ?? 0)),
    adGmv: round2(Number(g.orderPayAmt ?? 0)),
    orders: Number(g.orderPayCnt ?? 0),
    clicks: Number(g.clkCnt ?? 0),
    impressions: Number(g.imprCnt ?? 0),
    roas: Number(g.roas ?? ratio(g.orderPayAmt, g.spend)) || 0,
    acos: Number(g.acos ?? pct(g.spend, g.orderPayAmt)) || 0,
    ctr: Number(g.ctr ?? pct(g.clkCnt, g.imprCnt)) || 0,
  })).filter((g) => g.goodsId);
}

/**
 * Pull everything the dashboard needs, using the shared client (mock or live).
 * Failures are collected rather than thrown, so a missing scope degrades one
 * panel instead of blanking the page.
 */
export async function collect({ client, settings, days = 30, amountLookups = 45, adsDays = 14, maxOrderPages = 3, onProgress = () => {} }) {
  const out = { errors: [], orders: [], tokenInfo: null, ads: { summary: null, daily: [] }, adsGoods: [], goods: [], timings: {} };
  const timed = async (label, fn) => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      out.timings[label] = Date.now() - t0;
    }
  };

  onProgress({ step: 'token', pct: 5 });
  const tokenRes = await timed('token', () => client.call(DASHBOARD_CALLS.token));
  if (tokenRes.ok) out.tokenInfo = tokenRes.result;
  else out.errors.push({ step: 'token', errorCode: tokenRes.errorCode, errorMsg: tokenRes.errorMsg, error: tokenRes.error });

  onProgress({ step: 'orders', pct: 20 });
  const createAfter = Math.floor(Date.now() / 1000) - days * 86400;
  const collected = [];
  await timed('orders', async () => {
    for (let page = 1; page <= maxOrderPages; page++) {
      const res = await client.call(DASHBOARD_CALLS.orders, {
        pageNumber: page,
        pageSize: 100,
        createAfter,
        sortby: 'CREATE_TIME_DESC',
      });
      if (!res.ok) {
        out.errors.push({ step: `orders:page${page}`, errorCode: res.errorCode, errorMsg: res.errorMsg, error: res.error });
        break;
      }
      const items = res.result?.pageItems || [];
      collected.push(...ordersFromApi(items));
      const total = Number(res.result?.totalItemNum || 0);
      if (collected.length >= total || items.length === 0) break;
    }
  });
  out.orders = collected;
  onProgress({ step: 'orders', pct: 45, found: collected.length });

  const priced = out.orders.slice(0, amountLookups);
  onProgress({ step: 'amounts', pct: 50 });
  await timed('amounts', async () => {
    for (const order of priced) {
      const res = await client.call(DASHBOARD_CALLS.amounts, { parentOrderSn: order.parentOrderSn });
      if (res.ok) attachAmounts(order, res.result);
      else out.errors.push({ step: 'amounts', parentOrderSn: order.parentOrderSn, errorCode: res.errorCode, errorMsg: res.errorMsg });
    }
  });
  out.amountCoverage = { priced: out.orders.filter((o) => o.priced).length, total: out.orders.length };
  onProgress({ step: 'amounts', pct: 75, priced: out.amountCoverage.priced });

  onProgress({ step: 'ads', pct: 80 });
  await timed('ads', async () => {
    const daily = [];
    const today = new Date();
    for (let i = adsDays - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const startTs = Math.floor(d.getTime() / 1000);
      const endTs = startTs + 86399;
      const res = await client.call(DASHBOARD_CALLS.adsMall, { startTs, endTs, selectedAdManagedType: 1 });
      if (!res.ok) {
        out.errors.push({ step: 'ads', day: d.toISOString().slice(0, 10), errorCode: res.errorCode, errorMsg: res.errorMsg });
        continue;
      }
      const parsed = adsFromApi(res.result, { dayLabel: d.toISOString().slice(0, 10) });
      if (parsed.daily[0]) daily.push(parsed.daily[0]);
    }
    out.ads.daily = daily;
    out.ads.summary = aggregateAds(daily);
  });

  const goodsRes = await timed('adsGoods', () => client.call(DASHBOARD_CALLS.adsGoods, { startTs: Math.floor(Date.now() / 1000) - adsDays * 86400, endTs: Math.floor(Date.now() / 1000), selectedAdManagedType: 1 }));
  if (goodsRes.ok) out.adsGoods = goodsAdsFromApi(goodsRes.result);

  const goodsListRes = await timed('goods', () => client.call(DASHBOARD_CALLS.goods, { pageNumber: 1, pageSize: 50 }));
  if (goodsListRes.ok) out.goods = goodsListRes.result?.goodsList || [];

  onProgress({ step: 'done', pct: 100 });
  return out;
}

function aggregateAds(daily) {
  if (!daily.length) return null;
  const sum = (k) => round2(daily.reduce((s, d) => s + (Number(d[k]) || 0), 0));
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const spend = sum('spend');
  const orders = sum('orders');
  const adGmv = sum('adGmv');
  const carts = sum('carts');
  return {
    impressions, clicks, carts, orders, adGmv, spend,
    ctr: pct(clicks, impressions),
    cvr: pct(orders, clicks),
    roas: ratio(adGmv, spend),
    acos: pct(spend, adGmv),
    cpc: ratio(spend, clicks),
    cpm: impressions ? round2((spend / impressions) * 1000) : 0,
    epc: clicks ? round2(adGmv / clicks) : 0,
  };
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const pct = (a, b) => (b ? round2((a / b) * 100) : 0);
export const ratio = (a, b) => (b ? round2(a / b) : 0);
