/**
 * metrics.js — turn collected API data into the numbers on the dashboard.
 *
 * Two kinds of money appear here and they are deliberately kept apart:
 *   - settlement  : real, from temu.order.amount.v2.query (what Temu will pay
 *                   the seller after deductions).
 *   - commission  : for affiliate/business reporting. Real when imported from a
 *                   CSV export; otherwise a *projection* at a rate you set, and
 *                   labelled as a projection everywhere it is shown.
 */
import { round2, pct, ratio } from './normalize.js';
import { summarizeCsv } from './adapters/csv.js';

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export function computeDashboard({ collected, settings }) {
  const orders = collected.orders || [];
  const priced = orders.filter((o) => o.priced);
  const ads = collected.ads?.summary || null;
  const adsDaily = collected.ads?.daily || [];
  const csv = settings.adapter === 'csv' ? summarizeCsv(settings.csvDataset) : null;
  const currency = currencyOf(orders, settings, csv);

  // ---- order money ----
  const gmv = round2(priced.reduce((s, o) => s + (o.gmv || 0), 0));
  const settlement = round2(priced.reduce((s, o) => s + (o.settlement || 0), 0));
  const deductions = round2(priced.reduce((s, o) => s + (o.deduction || 0), 0));
  const refunds = round2(priced.reduce((s, o) => s + (o.refundedTotal || 0), 0));
  const units = orders.reduce((s, o) => s + (o.itemCount || 0), 0); // quantities need no amount lookup
  const refundedOrders = orders.filter((o) => o.status === 5 || o.refundedTotal > 0).length;
  const cancelledOrders = orders.filter((o) => o.status === 4).length;
  const unshipped = orders.filter((o) => o.status === 1);
  const now = Date.now();
  const agedUnshipped = unshipped.filter((o) => o.created && now - o.created > settings.alerts.unshippedAgeHours * 3600_000);

  // ---- commission / earnings ----
  const rate = Number(settings.assumedCommissionRate) || 0;
  const earnings = csv
    ? {
        mode: 'imported',
        label: 'Imported affiliate export',
        commission: csv.totals.commission,
        rate: csv.derived.commissionRate,
        epc: csv.derived.epc,
        note: `Totals from ${csv.rowCount} imported rows.`,
      }
    : {
        mode: 'projection',
        label: `Projection at ${rate}%`,
        commission: round2(settlement * (rate / 100)),
        rate,
        epc: ads?.clicks ? round2((settlement * (rate / 100)) / ads.clicks) : 0,
        note: 'Temu does not publish an affiliate commission API; this is your settlement × the rate you configured.',
      };

  // ---- daily series ----
  const byDay = new Map();
  const ensure = (date) => {
    if (!byDay.has(date)) {
      byDay.set(date, { date, orders: 0, units: 0, gmv: 0, settlement: 0, refunds: 0, adSpend: 0, adGmv: 0, clicks: 0, impressions: 0, carts: 0, adOrders: 0 });
    }
    return byDay.get(date);
  };
  for (const o of priced) {
    const d = ensure(o.created ? dayKey(o.created) : dayKey(now));
    d.orders += 1;
    d.units += o.itemCount || 0;
    d.gmv = round2(d.gmv + (o.gmv || 0));
    d.settlement = round2(d.settlement + (o.settlement || 0));
    d.refunds = round2(d.refunds + (o.refundedTotal || 0));
  }
  for (const a of adsDaily) {
    const d = ensure(a.date || dayKey(now));
    d.adSpend = round2(d.adSpend + (a.spend || 0));
    d.adGmv = round2(d.adGmv + (a.adGmv || 0));
    d.clicks += a.clicks || 0;
    d.impressions += a.impressions || 0;
    d.carts += a.carts || 0;
    d.adOrders += a.orders || 0;
  }
  const series = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, roas: ratio(d.adGmv, d.adSpend), acos: pct(d.adSpend, d.adGmv), ctr: pct(d.clicks, d.impressions), cvr: pct(d.adOrders, d.clicks) }));

  // ---- breakdowns ----
  const regions = group(orders, (o) => o.siteName || 'Unknown', (o) => ({ orders: 1, gmv: o.gmv || 0, units: o.itemCount || 0 }));
  const goodsMap = new Map();
  for (const o of orders) {
    for (const it of o.items || []) {
      const e = goodsMap.get(it.goodsId) || { goodsId: it.goodsId, goodsName: it.goodsName, category: it.category, units: 0, orders: 0, adSpend: 0, adGmv: 0, roas: 0 };
      e.units += it.quantity || 0;
      e.orders += 1;
      goodsMap.set(it.goodsId, e);
    }
  }
  for (const g of collected.adsGoods || []) {
    const e = goodsMap.get(g.goodsId) || { goodsId: g.goodsId, goodsName: g.goodsName, units: 0, orders: 0, adSpend: 0, adGmv: 0, roas: 0 };
    e.adSpend = g.spend;
    e.adGmv = g.adGmv;
    e.roas = g.roas;
    goodsMap.set(g.goodsId, e);
  }
  const topGoods = [...goodsMap.values()].sort((a, b) => b.units - a.units || b.adGmv - a.adGmv).slice(0, 12);

  const statusBreakdown = group(orders, (o) => o.statusLabel || 'Unknown', () => ({ orders: 1 }));

  const funnel = ads
    ? [
        { stage: 'Impressions', value: ads.impressions },
        { stage: 'Clicks', value: ads.clicks, rate: pct(ads.clicks, ads.impressions) },
        { stage: 'Carts', value: ads.carts, rate: pct(ads.carts, ads.clicks) },
        { stage: 'Paid orders', value: ads.orders, rate: pct(ads.orders, ads.carts) },
      ]
    : [];

  const coverage = collected.amountCoverage || { priced: priced.length, total: orders.length };

  // Multi-market sellers trade in several currencies. Without FX rates we must not
  // silently add JPY to USD, so totals are reported in the dominant currency and
  // the mixing is exposed to the UI.
  const currencyRows = [...orders.reduce((map, o) => {
    if (!o.currency) return map;
    const e = map.get(o.currency) || { currency: o.currency, orders: 0, gmv: 0, settlement: 0 };
    e.orders += 1;
    e.gmv = round2(e.gmv + (o.gmv || 0));
    e.settlement = round2(e.settlement + (o.settlement || 0));
    map.set(o.currency, e);
    return map;
  }, new Map()).values()].sort((a, b) => b.orders - a.orders);

  return {
    currency,
    currencies: currencyRows,
    mixedCurrency: currencyRows.length > 1,
    generatedAt: new Date().toISOString(),
    kpis: {
      orders: orders.length,
      pricedOrders: coverage.priced,
      amountCoveragePct: pct(coverage.priced, Math.max(coverage.total, 1)),
      units,
      gmv,
      settlement,
      deductions,
      refunds,
      aov: priced.length ? round2(gmv / priced.length) : 0,
      refundRatePct: pct(refundedOrders, Math.max(orders.length, 1)),
      cancelRatePct: pct(cancelledOrders, Math.max(orders.length, 1)),
      unshipped: unshipped.length,
      agedUnshipped: agedUnshipped.length,
      oldestUnshippedHours: agedUnshipped.length
        ? Math.round(Math.max(...agedUnshipped.map((o) => (now - o.created) / 3600_000)))
        : unshipped.length
          ? Math.round(Math.max(...unshipped.map((o) => (now - o.created) / 3600_000)))
          : 0,
      conversionRatePct: pct(orders.length, Math.max(ads?.clicks || 0, 1)),
    },
    ads,
    earnings,
    csv: csv ? { ...csv, columns: settings.csvDataset?.columns, unmapped: settings.csvDataset?.unmapped, source: settings.csvDataset?.source } : null,
    series,
    regions: regions.map((r) => ({ ...r, sharePct: pct(r.gmv || r.orders, gmv || orders.length) })),
    statusBreakdown,
    topGoods,
    funnel,
    orders,
    health: {
      errors: collected.errors || [],
      timings: collected.timings || {},
      coverage,
    },
  };
}

function currencyOf(orders, settings, csv) {
  const explicit = settings.currency || csv?.currency;
  if (explicit) return explicit;
  // Dominant currency by order count, not "whichever order came back first".
  const counts = new Map();
  for (const o of orders) if (o.currency) counts.set(o.currency, (counts.get(o.currency) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [code, n] of counts) if (n > bestN) { best = code; bestN = n; }
  return best || 'USD';
}

function group(rows, keyFn, valueFn) {
  const map = new Map();
  for (const row of rows) {
    const k = keyFn(row);
    const v = valueFn(row);
    const e = map.get(k) || {};
    for (const [kk, vv] of Object.entries(v)) e[kk] = (e[kk] || 0) + vv;
    map.set(k, e);
  }
  return [...map.entries()].map(([name, v]) => ({
    name,
    ...Object.fromEntries(Object.entries(v).map(([k, n]) => [k, round2(n)])),
  })).sort((a, b) => (b.gmv || 0) - (a.gmv || 0) || (b.orders || 0) - (a.orders || 0));
}

export { summarizeCsv };
