/**
 * adapters/csv.js — import a CSV export from an affiliate/partner report.
 *
 * Why this exists: affiliate.temu.com does not expose a public reporting API for
 * affiliates (only the seller/ERP Partner Platform is documented). So the honest
 * ways to get affiliate numbers into one dashboard are (a) import the export the
 * affiliate portal lets you download, or (b) go through an affiliate network that
 * does have an API and map its numbers here.
 *
 * The importer auto-detects columns, so it accepts exports from most networks
 * without hand-editing headers.
 */

const COLUMN_ALIASES = {
  date: ['date', 'day', 'report_date', 'reportdate', 'time', 'stat_date', 'transaction_date'],
  clicks: ['clicks', 'click', 'clk', 'clk_cnt', 'clkcnt', 'unique_clicks'],
  impressions: ['impressions', 'impr', 'impr_cnt', 'imprcnt', 'views', 'impression'],
  orders: ['orders', 'order', 'order_cnt', 'ordercnt', 'order_cnt', 'orderpaycnt', 'conversions', 'sales_count', 'qty_orders', 'transactions'],
  gmv: ['gmv', 'sales', 'revenue', 'sale_amount', 'order_amount', 'orderpayamt', 'order_value', 'commissionable_sales', 'turnover', 'amount'],
  commission: ['commission', 'earnings', 'payout', 'reward', 'commission_amount', 'estimated_commission', 'income', 'revenue_share'],
  spend: ['spend', 'cost', 'ad_spend', 'adspend', 'ad_cost'],
  status: ['status', 'order_status', 'state', 'transaction_status'],
  country: ['country', 'region', 'site', 'geo', 'market'],
  subId: ['subid', 'sub_id', 'sub_id_1', 'channel', 'source', 'tracking_id', 'campaign'],
  productName: ['product', 'product_name', 'item', 'goods_name', 'goodsname', 'sku_name'],
  orderId: ['order_id', 'orderid', 'order_sn', 'parent_order_sn', 'transaction_id', 'reference'],
  currency: ['currency', 'curr'],
};

/** RFC4180-ish CSV parser (handles quotes, embedded commas/newlines, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function detectColumns(header) {
  const found = {};
  const used = new Set();
  const normalised = header.map(norm);
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalised.findIndex((h, i) => !used.has(i) && aliases.includes(h));
    if (idx >= 0) { found[key] = idx; used.add(idx); }
  }
  return { map: found, unmapped: header.filter((_, i) => !used.has(i)) };
}

const toNumber = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};

function toEpoch(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const d = new Date(s.replace(/\./g, '-').replace(/\//g, '-'));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Import a CSV export.
 * @returns {{rows: object[], map: object, unmapped: string[], currency: string, source: string}}
 */
export function importCsv(text, { source = 'csv' } = {}) {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const [header, ...body] = table;
  const { map, unmapped } = detectColumns(header);
  if (map.gmv === undefined && map.commission === undefined && map.orders === undefined) {
    throw new Error(`could not find sales/commission/orders columns. Detected: ${Object.keys(map).join(', ') || 'none'}`);
  }

  let currency = '';
  const rows = body.map((cells) => {
    const get = (k) => (map[k] !== undefined ? cells[map[k]] : undefined);
    if (!currency && get('currency')) currency = String(get('currency')).trim().toUpperCase().slice(0, 3);
    const ts = toEpoch(get('date'));
    return {
      ts: ts ?? Date.now(),
      date: ts ? new Date(ts).toISOString().slice(0, 10) : '',
      clicks: toNumber(get('clicks')),
      impressions: toNumber(get('impressions')),
      orders: toNumber(get('orders')),
      gmv: toNumber(get('gmv')),
      commission: toNumber(get('commission')),
      spend: toNumber(get('spend')),
      status: get('status') ? String(get('status')).trim() : '',
      country: get('country') ? String(get('country')).trim().toUpperCase() : '',
      subId: get('subId') ? String(get('subId')).trim() : '',
      productName: get('productName') ? String(get('productName')).trim() : '',
      orderId: get('orderId') ? String(get('orderId')).trim() : '',
    };
  });

  return { rows, map, unmapped, currency: currency || 'USD', source, importedAt: Date.now(), columns: header };
}

/** Aggregate an imported dataset into the same shapes the dashboard uses. */
export function summarizeCsv(dataset) {
  const rows = dataset?.rows || [];
  const byDay = new Map();
  for (const r of rows) {
    const key = r.date || new Date(r.ts).toISOString().slice(0, 10);
    const d = byDay.get(key) || { date: key, clicks: 0, impressions: 0, orders: 0, gmv: 0, commission: 0, spend: 0 };
    d.clicks += r.clicks;
    d.impressions += r.impressions;
    d.orders += r.orders;
    d.gmv += r.gmv;
    d.commission += r.commission;
    d.spend += r.spend;
    byDay.set(key, d);
  }
  const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({
    ...round2All(d),
    ctr: d.impressions ? Math.round((d.clicks / d.impressions) * 10000) / 100 : 0,
    cvr: d.clicks ? Math.round((d.orders / d.clicks) * 10000) / 100 : 0,
    epc: d.clicks ? Math.round((d.commission / d.clicks) * 10000) / 100 : 0,
    roas: d.spend ? Math.round((d.gmv / d.spend) * 100) / 100 : 0,
  }));

  const total = daily.reduce((acc, d) => {
    acc.clicks += d.clicks; acc.impressions += d.impressions; acc.orders += d.orders;
    acc.gmv += d.gmv; acc.commission += d.commission; acc.spend += d.spend;
    return acc;
  }, { clicks: 0, impressions: 0, orders: 0, gmv: 0, commission: 0, spend: 0 });

  const bySubId = new Map();
  for (const r of rows) {
    const key = r.subId || r.country || r.productName || 'all';
    const e = bySubId.get(key) || { key, clicks: 0, orders: 0, gmv: 0, commission: 0 };
    e.clicks += r.clicks; e.orders += r.orders; e.gmv += r.gmv; e.commission += r.commission;
    bySubId.set(key, e);
  }

  return {
    daily,
    totals: round2All(total),
    breakdown: [...bySubId.values()].map(round2All).sort((a, b) => b.commission - a.commission).slice(0, 12),
    rowCount: rows.length,
    currency: dataset.currency,
    derived: {
      epc: total.clicks ? Math.round((total.commission / total.clicks) * 10000) / 100 : 0,
      aov: total.orders ? Math.round((total.gmv / total.orders) * 100) / 100 : 0,
      commissionRate: total.gmv ? Math.round((total.commission / total.gmv) * 10000) / 100 : 0,
      ctr: total.impressions ? Math.round((total.clicks / total.impressions) * 10000) / 100 : 0,
      cvr: total.clicks ? Math.round((total.orders / total.clicks) * 10000) / 100 : 0,
      roas: total.spend ? Math.round((total.gmv / total.spend) * 100) / 100 : 0,
    },
  };
}

function round2All(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
  return out;
}
