/**
 * fixtures.js — deterministic synthetic Partner API data.
 *
 * Every generator is seeded, so the dashboard shows the same numbers on every
 * reload (and in tests) while still looking like a real account. The shapes
 * mirror the documented responses of the endpoints the dashboard consumes.
 *
 * Status/site labels are inferred from public order-number conventions and are
 * marked as inferred in the UI — verify them against your own account.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;

export const SITES = [
  { siteId: 211, regionId: 211, code: 'US', label: 'United States', currency: 'USD', fx: 1 },
  { siteId: 212, regionId: 212, code: 'CA', label: 'Canada', currency: 'CAD', fx: 1.36 },
  { siteId: 213, regionId: 213, code: 'DE', label: 'Germany', currency: 'EUR', fx: 0.92 },
  { siteId: 214, regionId: 214, code: 'GB', label: 'United Kingdom', currency: 'GBP', fx: 0.79 },
  { siteId: 216, regionId: 216, code: 'MX', label: 'Mexico', currency: 'MXN', fx: 17.2 },
  { siteId: 217, regionId: 217, code: 'JP', label: 'Japan', currency: 'JPY', fx: 152 },
];

/** Parent-order statuses as used by the order APIs (labels inferred). */
export const ORDER_STATUS = {
  1: 'Pending shipment',
  2: 'Shipped',
  3: 'Delivered',
  4: 'Cancelled',
  5: 'Refunded',
  6: 'Partially shipped',
  7: 'Closed',
};

const GOODS = [
  { goodsId: 601099548666279, goodsName: 'Wireless Earbuds Pro, ANC, 36h Playtime', category: 'Audio', cost: 8.4 },
  { goodsId: 601099548671002, goodsName: 'Stainless Steel Insulated Tumbler 40oz', category: 'Home', cost: 5.1 },
  { goodsId: 601099548680131, goodsName: 'LED Strip Lights 16.4ft RGB Smart', category: 'Lighting', cost: 6.2 },
  { goodsId: 601099548692774, goodsName: 'Winter Puffer Jacket, Water-Resistant', category: 'Apparel', cost: 14.8 },
  { goodsId: 601099548701556, goodsName: 'Pet Grooming Brush, Self-Cleaning', category: 'Pets', cost: 2.9 },
  { goodsId: 601099548712208, goodsName: 'Magnetic Phone Mount for Car Dashboard', category: 'Auto', cost: 3.4 },
  { goodsId: 601099548723910, goodsName: 'Kitchen Knife Set, 6-Piece with Block', category: 'Kitchen', cost: 11.3 },
  { goodsId: 601099548735442, goodsName: 'Kids Building Blocks, 500 Pieces', category: 'Toys', cost: 7.6 },
  { goodsId: 601099548746119, goodsName: 'Yoga Mat 1/2 inch, Non-Slip TPE', category: 'Sports', cost: 6.8 },
  { goodsId: 601099548757330, goodsName: 'Desk Organiser with Drawer, Bamboo', category: 'Office', cost: 5.9 },
  { goodsId: 601099548768045, goodsName: 'Solar Garden Lights, 4-Pack Waterproof', category: 'Garden', cost: 4.2 },
  { goodsId: 601099548779201, goodsName: 'USB-C Fast Charger 65W GaN', category: 'Electronics', cost: 9.7 },
];

const REGION_WEIGHTS = [0.44, 0.12, 0.16, 0.09, 0.11, 0.08];

function weightedSite(rand) {
  let r = rand();
  for (let i = 0; i < SITES.length; i++) {
    r -= REGION_WEIGHTS[i];
    if (r <= 0) return SITES[i];
  }
  return SITES[0];
}

const dayStart = (ts) => Math.floor(ts / 86400) * 86400;

/**
 * Generate parent orders for the last `days` days ending at `now`.
 * Returns normalised internal records (not raw API envelopes).
 */
export function generateOrders({ days = 30, now = Date.now(), seed = 20261013, perDay = [26, 92] } = {}) {
  const rand = mulberry32(seed);
  const orders = [];
  const endDay = dayStart(now);

  for (let d = days - 1; d >= 0; d--) {
    const dayTs = endDay - d * 86400;
    const weekend = [0, 6].includes(new Date(dayTs * 1000).getUTCDay());
    const seasonal = 1 + 0.18 * Math.sin((d / days) * Math.PI * 2);
    const count = Math.round((perDay[0] + rand() * (perDay[1] - perDay[0])) * (weekend ? 1.18 : 1) * seasonal);

    for (let i = 0; i < count; i++) {
      const site = weightedSite(rand);
      const created = dayTs + Math.floor(rand() * 86_400);
      const items = Array.from({ length: rand() < 0.72 ? 1 : 1 + Math.floor(rand() * 3) }, () => {
        const g = pick(rand, GOODS);
        const qty = rand() < 0.82 ? 1 : 1 + Math.floor(rand() * 3);
        const unit = round2((g.cost * (2.1 + rand() * 1.5)) * site.fx);
        return {
          goodsId: g.goodsId,
          goodsName: g.goodsName,
          skuId: 62897648567566 + Math.floor(rand() * 5000),
          spec: pick(rand, ['Black / Standard', 'White / L', 'Blue / One Size', 'Grey / 2-Pack']),
          quantity: qty,
          unitPrice: unit,
          lineTotal: round2(unit * qty),
          fulfillmentType: pick(rand, ['FULFILLED_BY_SELLER', 'FULFILLED_BY_TEMU', 'SEMI_MANAGED']),
          category: g.category,
          unitCost: round2(g.cost * site.fx),
        };
      });

      const gmv = round2(items.reduce((s, it) => s + it.lineTotal, 0));
      const shipping = round2(gmv > 25 ? 0 : 2.99 * site.fx);
      const customerPaidTotal = round2(gmv + shipping);
      const statusRoll = rand();
      let status = 1;
      if (statusRoll > 0.965) status = 5;
      else if (statusRoll > 0.925) status = 4;
      else if (d > 6) status = rand() > 0.12 ? 3 : 2;
      else status = rand() > 0.55 ? 2 : 1;

      const cogs = round2(items.reduce((s, it) => s + it.unitCost * it.quantity, 0));
      const referralFee = round2(customerPaidTotal * 0.05);
      const fulfillmentFee = round2(items.reduce((s, it) => s + it.quantity * 1.35 * site.fx, 0));
      const adsAttributed = rand() < 0.34;
      const estimatedSettlementTotal = round2(customerPaidTotal - referralFee - fulfillmentFee);
      const shippedAt = status === 2 || status === 3 ? created + Math.floor(3600 * (12 + rand() * 36)) : null;

      orders.push({
        parentOrderSn: `PO-${site.siteId}-${String(21000000000000000 + Math.floor(rand() * 899999999999999))}`,
        siteCode: site.code,
        siteLabel: site.label,
        siteId: site.siteId,
        regionId: site.regionId,
        currency: site.currency,
        created,
        updated: shippedAt || created,
        shippedAt,
        status,
        statusLabel: ORDER_STATUS[status],
        parentConfirmTime: created + 120,
        expectShipLatestTime: created + 2 * 86400,
        fulfillmentWarning: status === 1 && now / 1000 - created > 2 * 86400 ? ['LATE_SHIPMENT_RISK'] : [],
        items,
        itemCount: items.reduce((s, it) => s + it.quantity, 0),
        gmv,
        shipping,
        customerPaidTotal,
        estimatedSettlementTotal,
        referralFee,
        fulfillmentFee,
        cogs,
        margin: round2(estimatedSettlementTotal - cogs),
        refunded: status === 5,
        cancelled: status === 4,
        adsAttributed,
        orderPaymentType: pick(rand, ['CARD', 'PAYPAL', 'APPLE_PAY', 'KLARNA']),
      });
    }
  }
  return orders.sort((a, b) => b.created - a.created);
}

/** Daily ad performance for the last `days` days (search & recommendation ads). */
export function generateAdsDaily({ days = 30, now = Date.now(), seed = 777001 } = {}) {
  const rand = mulberry32(seed);
  const endDay = dayStart(now);
  const rows = [];
  for (let d = days - 1; d >= 0; d--) {
    const dayTs = endDay - d * 86400;
    const imprCnt = Math.round(48_000 + rand() * 42_000);
    const ctr = 0.011 + rand() * 0.012;
    const clkCnt = Math.round(imprCnt * ctr);
    const spend = round2(clkCnt * (0.34 + rand() * 0.22));
    const cvr = 0.028 + rand() * 0.03;
    const orderPayCnt = Math.max(1, Math.round(clkCnt * cvr));
    const aov = 34 + rand() * 26;
    const orderPayAmt = round2(orderPayCnt * aov);
    const cartCnt = Math.round(clkCnt * (0.06 + rand() * 0.05));
    rows.push({
      date: dayTs,
      imprCnt,
      clkCnt,
      spend,
      cartCnt,
      orderPayCnt,
      orderPayAmt,
      ctr: round2((clkCnt / imprCnt) * 10000) / 100,
      cvr: round2((orderPayCnt / clkCnt) * 10000) / 100,
      roas: round2((orderPayAmt / spend) * 100) / 100,
      acos: round2((spend / orderPayAmt) * 10000) / 100,
      transactionCost: round2((spend / orderPayCnt) * 100) / 100,
      goodsNum: orderPayCnt + Math.round(rand() * 12),
      selectedAdManagedType: 1,
    });
  }
  return rows;
}

/** Per-goods ad performance table. */
export function generateAdsGoods({ days = 14, now = Date.now(), seed = 424242 } = {}) {
  const rand = mulberry32(seed);
  return GOODS.map((g) => {
    const imprCnt = Math.round(4000 + rand() * 26_000);
    const clkCnt = Math.round(imprCnt * (0.01 + rand() * 0.014));
    const spend = round2(clkCnt * (0.3 + rand() * 0.3));
    const orderPayCnt = Math.max(0, Math.round(clkCnt * (0.02 + rand() * 0.035)));
    const orderPayAmt = round2(orderPayCnt * (18 + rand() * 30));
    return {
      goodsId: g.goodsId,
      goodsName: g.goodsName,
      category: g.category,
      imprCnt,
      clkCnt,
      spend,
      orderPayCnt,
      orderPayAmt,
      cartCnt: Math.round(clkCnt * 0.08),
      ctr: imprCnt ? round2((clkCnt / imprCnt) * 10000) / 100 : 0,
      cvr: clkCnt ? round2((orderPayCnt / clkCnt) * 10000) / 100 : 0,
      roas: spend ? round2((orderPayAmt / spend) * 100) / 100 : 0,
      acos: orderPayAmt ? round2((spend / orderPayAmt) * 10000) / 100 : 0,
    };
  }).sort((a, b) => b.spend - a.spend);
}

/** Goods catalogue rows (for the catalogue panel / scope checks). */
export function generateGoodsCatalogue({ seed = 90210 } = {}) {
  const rand = mulberry32(seed);
  return GOODS.map((g) => ({
    goodsId: g.goodsId,
    goodsName: g.goodsName,
    category: g.category,
    skuCount: 1 + Math.floor(rand() * 4),
    price: round2(g.cost * (2.4 + rand() * 1.4)),
    stock: Math.round(40 + rand() * 900),
    saleStatus: rand() > 0.12 ? 'ON_SALE' : 'OFF_SHELF',
    publishStatus: rand() > 0.06 ? 'PUBLISHED' : 'DRAFT',
    updatedAt: Date.now() - Math.floor(rand() * 20 * 86400_000),
  }));
}

/** Token/authorisation health for bg.open.accesstoken.info.get. */
export function generateTokenInfo({ scopes = [], now = Date.now(), seed = 5150 } = {}) {
  const rand = mulberry32(seed);
  return {
    semiUniqueId: 'upl' + Math.floor(rand() * 1e6).toString(36),
    mallId: 1024,
    mallType: 1,
    regionId: 211,
    expiredTime: Math.floor(now / 1000) + 86400 * (11 + Math.floor(rand() * 12)),
    appSubscribeStatus: 1,
    appSubscribeEventCodeList: [
      'bg_order_status_change_event',
      'bg_aftersales_status_change',
      'bg_cancel_order_status_change',
    ],
    authEventCodeList: scopes.map((s) => ({ eventCode: s, permitsStatus: 1 })),
    apiScopeList: scopes,
  };
}
