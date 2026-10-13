/**
 * adapters/mock.js — a synthetic but faithful Temu gateway.
 *
 * It speaks the same envelopes as the real router (common params + sign in,
 * success/errorCode/errorMsg/result out), and it *verifies the MD5 signature*
 * exactly like the real gateway. That makes the mock a genuine integration
 * test for the signing path, not just a data stub.
 */
import { computeSign } from '../sign.js';
import {
  generateOrders, generateAdsDaily, generateAdsGoods, generateGoodsCatalogue,
  generateTokenInfo, ORDER_STATUS, SITES,
} from '../fixtures.js';

export const MOCK_APP_SECRET = process.env.TEMU_MOCK_SECRET || 'mock_app_secret_0001';
export const MOCK_APP_KEY = 'mock_app_key_0001';
export const MOCK_ACCESS_TOKEN = 'mock_access_token_0001';

export const DASHBOARD_SCOPES = [
  'bg.open.accesstoken.info.get',
  'bg.order.list.v2.get',
  'bg.order.detail.v2.get',
  'temu.order.amount.v2.query',
  'temu.searchrec.ad.reports.mall.query',
  'temu.searchrec.ad.reports.goods.query',
  'bg.local.goods.list.query',
  'bg.logistics.shipment.get',
];

const err = (errorCode, errorMsg) => ({ success: false, errorCode, errorMsg, result: null });
const ok = (result) => ({ success: true, errorCode: 1000000, errorMsg: '', result });
const cur = (currency, amount) => ({ currency, amount });

export function createMockTransport({ now = () => Date.now(), seed = 20261013, region = 'US' } = {}) {
  const orders = generateOrders({ days: 45, now: now(), seed });
  const adsDaily = generateAdsDaily({ days: 45, now: now(), seed: seed + 1 });
  const adsGoods = generateAdsGoods({ now: now(), seed: seed + 2 });
  const goods = generateGoodsCatalogue({ seed: seed + 3 });
  const currency = region === 'EU' ? 'EUR' : region === 'US' ? 'USD' : 'MXN';
  const toSiteCurrency = (amount, orderCurrency) =>
    orderCurrency === currency ? amount : Math.round((amount / 1.0) * 100) / 100;

  const amountFor = (o) => ({
    parentOrderSn: o.parentOrderSn,
    customerPaid: {
      customerPaidTotal: cur(o.currency, o.customerPaidTotal),
      retailPriceTotalTaxIncl: cur(o.currency, o.gmv),
      retailPriceTotalTaxExcl: cur(o.currency, Math.round(o.gmv / 1.07 * 100) / 100),
      shippingTotalTaxIncl: cur(o.currency, o.shipping),
      shippingTotalTaxExcl: cur(o.currency, Math.round(o.shipping / 1.07 * 100) / 100),
      productRefundsTotal: cur(o.currency, o.refunded ? o.gmv : 0),
      shippingTaxCustomerTotal: cur(o.currency, Math.round(o.shipping * 0.07 * 100) / 100),
      productTaxCustomerTotal: cur(o.currency, Math.round(o.gmv * 0.07 * 100) / 100),
    },
    salesProceeds: {
      estimatedSettlementTotal: cur(o.currency, o.estimatedSettlementTotal),
      estimatedDeduction: cur(o.currency, round2(o.referralFee + o.fulfillmentFee)),
      basePriceTotal: cur(o.currency, o.gmv),
      basePriceDiscountedTotal: cur(o.currency, o.gmv),
      basePriceOff: cur(o.currency, round2(o.gmv * 0.04)),
      basePriceSellerDiscount: cur(o.currency, 0),
      shippingTotalTaxExcl: cur(o.currency, Math.round(o.shipping / 1.07 * 100) / 100),
      shippingTemuTotalTaxExcl: cur(o.currency, 0),
      shippingCustomerTotalTaxExcl: cur(o.currency, Math.round(o.shipping / 1.07 * 100) / 100),
      productTax: cur(o.currency, Math.round(o.gmv * 0.07 * 100) / 100),
      productTaxTemu: cur(o.currency, 0),
      taxTemuDiscount: cur(o.currency, 0),
      shippingTax: cur(o.currency, Math.round(o.shipping * 0.07 * 100) / 100),
      shippingTaxTemu: cur(o.currency, 0),
      productTaxCustomerDiscounted: cur(o.currency, 0),
      shippingTaxCustomerDiscounted: cur(o.currency, 0),
    },
  });

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    id: 'mock',
    label: 'Mock gateway (synthetic data, real envelope + real sign check)',
    appKey: MOCK_APP_KEY,
    appSecret: MOCK_APP_SECRET,
    accessToken: MOCK_ACCESS_TOKEN,

    /** Gateway-shaped POST. Verifies sign exactly like the production router. */
    async send({ body }) {
      const { sign, ...rest } = body;
      const expected = computeSign(MOCK_APP_SECRET, rest);
      if (String(sign || '').toUpperCase() !== expected) {
        return { status: 200, json: err(3000001, 'SIGN_UNVALID') };
      }
      if (!rest.app_key) return { status: 200, json: err(3000025, 'there is no app_key in body.') };
      if (!rest.access_token) return { status: 200, json: err(3000030, 'there is no access_token in body.') };
      if (Math.abs(Number(rest.timestamp) - Math.floor(now() / 1000)) > 300) {
        return { status: 200, json: err(3000012, 'timestamp is expired.') };
      }

      const sim = rest.__simulate;
      if (sim === 'RATE_LIMIT') return { status: 200, json: err(4000004, 'RATE_LIMIT_EXCEED_EXCEPTION') };
      if (sim === 'SYSTEM') return { status: 200, json: err(4000000, 'SYSTEM_EXCEPTION') };
      if (sim === 'SCOPE') return { status: 200, json: err(3000032, "access_token don't have this api access") };
      if (sim === 'TOKEN') return { status: 200, json: err(3000034, 'access_token is expired or have been refreshed') };
      if (sim === 'IP') return { status: 200, json: err(5000003, 'NOT_IN_IP_WHITE_LIST') };

      return { status: 200, json: this.handle(rest.type, rest) };
    },

    /** Business handlers keyed by API type. */
    handle(type, params = {}) {
      switch (type) {
        case 'bg.open.accesstoken.info.get': {
          const info = generateTokenInfo({ scopes: DASHBOARD_SCOPES, now: now(), seed });
          return ok(info);
        }
        case 'bg.open.accesstoken.create':
          return ok({
            accessToken: MOCK_ACCESS_TOKEN,
            expiredTime: Math.floor(now() / 1000) + 86400 * 30,
            mallId: 1024,
            apiScopeList: DASHBOARD_SCOPES,
            appSubscribeEventCodeList: ['bg_order_status_change_event'],
            appSubscribeStatus: 1,
          });

        case 'bg.order.list.v2.get': {
          let list = orders;
          if (params.parentOrderSnList?.length) {
            const set = new Set(params.parentOrderSnList);
            list = list.filter((o) => set.has(o.parentOrderSn));
          }
          if (params.createAfter) list = list.filter((o) => o.created >= Number(params.createAfter) / 1000 || o.created >= Number(params.createAfter));
          if (params.createBefore) list = list.filter((o) => o.created <= Number(params.createBefore));
          if (params.parentOrderStatus) list = list.filter((o) => o.status === Number(params.parentOrderStatus));
          if (params.regionId) list = list.filter((o) => o.regionId === Number(params.regionId));
          const pageSize = Math.min(Number(params.pageSize) || 20, 100);
          const pageNumber = Math.max(Number(params.pageNumber) || 1, 1);
          const slice = list.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
          return ok({
            totalItemNum: list.length,
            pageItems: slice.map((o) => ({
              parentOrderMap: {
                parentOrderSn: o.parentOrderSn,
                parentOrderStatus: o.status,
                parentOrderTime: o.created,
                updateTime: o.updated,
                siteId: o.siteId,
                regionId: o.regionId,
                parentConfirmTime: o.parentConfirmTime,
                expectShipLatestTime: o.expectShipLatestTime,
                latestDeliveryTime: o.shippedAt ? o.shippedAt + 5 * 86400 : null,
                shippingMethod: 1,
                parentShippingTime: o.shippedAt,
                hasShippingFee: o.shipping > 0,
                orderPaymentType: o.orderPaymentType,
                fulfillmentWarning: o.fulfillmentWarning,
                parentOrderLabel: [{ name: o.adsAttributed ? 'ADS_ATTRIBUTED' : 'ORGANIC', value: 1 }],
              },
              orderList: o.items.map((it) => ({
                orderSn: `${o.parentOrderSn.replace('PO-', '')}-${it.skuId}`,
                goodsId: it.goodsId,
                goodsName: it.goodsName,
                originalGoodsName: it.goodsName,
                skuId: it.skuId,
                spec: it.spec,
                quantity: it.quantity,
                originalOrderQuantity: it.quantity,
                canceledQuantityBeforeShipment: o.cancelled ? it.quantity : 0,
                orderStatus: o.status,
                fulfillmentType: it.fulfillmentType,
                thumbUrl: `https://img.kwcdn.com/product/fake/${it.goodsId}/thumb.jpg`,
                orderCreateTime: o.created,
                orderShippingTime: o.shippedAt,
                isCancelledDuringPending: o.cancelled,
                packageAbnormalTypeList: o.fulfillmentWarning.length ? ['LATE_SHIPMENT_RISK'] : [],
                productList: [{ productId: it.goodsId, productSkuId: it.skuId, soldFactor: 1, extCode: null }],
              })),
            })),
          });
        }

        case 'bg.order.detail.v2.get': {
          const o = orders.find((x) => x.parentOrderSn === params.parentOrderSn);
          if (!o) return err(140020013, 'parentOrderSn not passed in');
          return ok({ parentOrderMap: { parentOrderSn: o.parentOrderSn, parentOrderStatus: o.status, parentOrderTime: o.created, siteId: o.siteId }, orderList: o.items });
        }

        case 'temu.order.amount.v2.query': {
          const o = orders.find((x) => x.parentOrderSn === params.parentOrderSn);
          if (!o) return err(140020013, 'parentOrderSn not passed in');
          return ok(amountFor(o));
        }

        case 'bg.order.amount.query': {
          const o = orders.find((x) => x.parentOrderSn === params.parentOrderSn);
          if (!o) return err(140020013, 'parentOrderSn not passed in');
          const a = amountFor(o);
          return ok({ parentOrderSn: o.parentOrderSn, ...a.customerPaid, ...a.salesProceeds });
        }

        case 'temu.searchrec.ad.reports.mall.query': {
          const start = Number(params.startTs) * (String(params.startTs).length > 10 ? 1 / 1000 : 1);
          const end = Number(params.endTs) * (String(params.endTs).length > 10 ? 1 / 1000 : 1);
          const rows = adsDaily.filter((r) => (!start || r.date >= start) && (!end || r.date <= end));
          return ok(buildAdsSummary(rows.length ? rows : adsDaily.slice(-7)));
        }

        case 'temu.searchrec.ad.reports.goods.query': {
          const filtered = params.goodsId ? adsGoods.filter((g) => g.goodsId === Number(params.goodsId)) : adsGoods;
          return ok(buildAdsSummary(filtered.map((g) => ({ ...g, date: 0 })), filtered));
        }

        case 'bg.local.goods.list.query':
        case 'temu.local.goods.list.retrieve': {
          const pageSize = Math.min(Number(params.pageSize) || 20, 100);
          const pageNumber = Math.max(Number(params.pageNumber) || 1, 1);
          const slice = goods.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
          return ok({
            total: goods.length,
            goodsList: slice.map((g) => ({
              goodsId: g.goodsId,
              goodsName: g.goodsName,
              category: g.category,
              price: { currency, amount: toSiteCurrency(g.price, currency) },
              stock: g.stock,
              saleStatus: g.saleStatus,
              publishStatus: g.publishStatus,
              updatedAt: g.updatedAt,
            })),
          });
        }

        case 'temu.local.mall.tags.get':
          return ok({ mallTags: [{ tagName: 'MALL_TYPE', tagValue: 'SEMI_MANAGED' }, { tagName: 'REGION', tagValue: region }] });

        case 'bg.logistics.shipment.get':
          return ok({ shipmentList: [], total: 0 });

        case 'bg.tmc.message.update':
          return ok({ subscribeResult: true, eventCodeList: params.eventCodeList || [] });

        default:
          // Unknown-but-valid type: return the documented response example if we
          // have one, otherwise an empty success so the playground never dead-ends.
          return ok({
            _note: 'Synthetic response from the mock gateway. Shape follows the documented common envelope.',
            type,
            echo: Object.fromEntries(Object.entries(params).filter(([k]) => !['sign', 'app_key', 'access_token', 'timestamp', 'data_type', 'version', 'type'].includes(k))),
          });
      }
    },
  };
}

/** Build the documented summary + reportsSummary block from daily rows. */
function buildAdsSummary(rows, goodsRows = null) {
  const sum = (k) => round2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  const imprCnt = sum('imprCnt');
  const clkCnt = sum('clkCnt');
  const spend = sum('spend');
  const orderPayCnt = sum('orderPayCnt');
  const orderPayAmt = sum('orderPayAmt');
  const cartCnt = sum('cartCnt');
  const metric = (v) => ({ total: { val: v }, ad: { val: v }, netTotal: { val: v }, netAd: { val: v } });

  const summary = {
    imprCnt: metric(imprCnt),
    clkCnt: metric(clkCnt),
    spend: metric(spend),
    cartCnt: metric(cartCnt),
    orderPayCnt: metric(orderPayCnt),
    orderPayAmt: metric(orderPayAmt),
    ctr: metric(pct(clkCnt, imprCnt)),
    cvr: metric(pct(orderPayCnt, clkCnt)),
    roas: metric(ratio(orderPayAmt, spend)),
    acos: metric(pct(spend, orderPayAmt)),
    transactionCost: metric(ratio(spend, orderPayCnt)),
    goodsNum: metric(orderPayCnt),
    adSpend: spend,
    netAdSpend: spend,
    totalImprCnt: imprCnt,
    totalClkCnt: clkCnt,
    totalCartCnt: cartCnt,
    totalOrderPayCnt: orderPayCnt,
    totalOrderPayAmt: orderPayAmt,
    totalCtr: pct(clkCnt, imprCnt),
    totalCvr: pct(orderPayCnt, clkCnt),
    totalRoas: ratio(orderPayAmt, spend),
    totalAcos: pct(spend, orderPayAmt),
    totalTransactionCost: ratio(spend, orderPayCnt),
    totalGoodsNum: orderPayCnt,
    netRoas: ratio(orderPayAmt, spend),
    netAcos: pct(spend, orderPayAmt),
  };

  return {
    summary,
    reportsSummary: {
      imprCntAll: { val: imprCnt },
      clkCntAll: { val: clkCnt },
      adSpendAll: { val: spend },
      cartCntAll: { val: cartCnt },
      orderPayCntAll: { val: orderPayCnt },
      orderPayAmtAll: { val: orderPayAmt },
      ctrAll: { val: pct(clkCnt, imprCnt) },
      cvrAll: { val: pct(orderPayCnt, clkCnt) },
      roasAll: { val: ratio(orderPayAmt, spend) },
      acosAll: { val: pct(spend, orderPayAmt) },
    },
    ...(goodsRows ? { goodsReports: goodsRows.map((g) => ({ goodsId: g.goodsId, goodsName: g.goodsName, ...g })) } : {}),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? round2((a / b) * 10000) / 100 : 0);
const ratio = (a, b) => (b ? round2((a / b) * 100) / 100 : 0);

export { ORDER_STATUS, SITES };
