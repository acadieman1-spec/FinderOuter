/**
 * alerts.js — the rules engine that makes this a dashboard and not just a chart
 * page. Every rule is a real operational failure mode of a Temu integration,
 * with the API evidence that triggered it.
 */
import { round2 } from './normalize.js';

/**
 * @param {object} input
 * @param {object} input.dashboard computed dashboard
 * @param {object} input.tokenInfo   bg.open.accesstoken.info.get result
 * @param {object} input.logStats    request-log statistics
 * @param {object} input.rate        rate-limiter snapshot
 * @param {object} input.settings    thresholds
 */
export function evaluateAlerts({ dashboard, tokenInfo, logStats, rate, settings }) {
  const alerts = [];
  const push = (a) => alerts.push({ id: `${a.rule}:${a.metric ?? ''}`, raisedAt: new Date().toISOString(), ...a });

  // 1. Token expiry — the classic silently-breaking integration.
  if (tokenInfo?.expiredTime) {
    const hoursLeft = (Number(tokenInfo.expiredTime) * 1000 - Date.now()) / 3600_000;
    if (hoursLeft <= 0) {
      push({
        rule: 'token-expired', severity: 'critical', metric: 'token',
        title: 'access_token has expired',
        detail: `Temu returned expiredTime=${tokenInfo.expiredTime} (${new Date(Number(tokenInfo.expiredTime) * 1000).toISOString()}).`,
        action: 'Re-run the authorisation flow (bg.open.accesstoken.create) and update the token.',
        value: round2(hoursLeft),
      });
    } else if (hoursLeft < settings.alerts.tokenExpiryHours) {
      push({
        rule: 'token-expiring', severity: 'warning', metric: 'token',
        title: `access_token expires in ${Math.round(hoursLeft)}h`,
        detail: `Threshold is ${settings.alerts.tokenExpiryHours}h. mallId=${tokenInfo.mallId ?? '—'} regionId=${tokenInfo.regionId ?? '—'}.`,
        action: 'Schedule a token refresh before it lapses, or the whole integration starts returning 3000034.',
        value: round2(hoursLeft),
      });
    }
  } else if (dashboard.health.errors.some((e) => e.errorCode === 3000034 || e.errorCode === 3000031)) {
    push({
      rule: 'token-invalid', severity: 'critical', metric: 'token',
      title: 'access_token rejected by the gateway',
      detail: 'bg.open.accesstoken.info.get returned a token error code.',
      action: 'Check TEMU_ACCESS_TOKEN and that the token belongs to this app_key (error 3000033 otherwise).',
    });
  }

  // 2. Missing scopes for the panels this dashboard renders.
  const scopes = tokenInfo?.apiScopeList;
  if (Array.isArray(scopes)) {
    const needed = [
      ['bg.order.list.v2.get', 'Orders'],
      ['temu.order.amount.v2.query', 'Settlement amounts'],
      ['temu.searchrec.ad.reports.mall.query', 'Ads reporting'],
    ];
    const missing = needed.filter(([s]) => !scopes.includes(s));
    if (missing.length) {
      push({
        rule: 'scope-missing', severity: 'warning', metric: 'scopes',
        title: `${missing.length} API scope(s) not authorised`,
        detail: `Missing: ${missing.map((m) => m[0]).join(', ')}. Panels affected: ${missing.map((m) => m[1]).join(', ')}.`,
        action: 'Ask the seller to authorise these APIs in the seller center, then refresh the access_token.',
        value: scopes.length,
      });
    }
  }

  // 3. Gateway error rate over the recent request log.
  if (logStats.total >= 5 && logStats.errorRatePct > settings.alerts.errorRatePct) {
    const top = Object.entries(logStats.byCode).sort((a, b) => b[1] - a[1])[0];
    push({
      rule: 'error-rate', severity: 'warning', metric: 'errors',
      title: `Error rate ${logStats.errorRatePct}% over last ${logStats.total} calls`,
      detail: top ? `Most frequent gateway code ${top[0]} (${top[1]}×).` : '',
      action: 'Open the request log and inspect the failing type.',
      value: logStats.errorRatePct,
    });
  }

  // 4. Rate limiting — hitting 4000004 means you are throttling yourself.
  const rateLimited = logStats.byCode?.[4000004] || 0;
  if (rateLimited > 0 || rate.denied > 0) {
    push({
      rule: 'rate-limit', severity: rateLimited > 3 ? 'warning' : 'info', metric: 'qps',
      title: `Rate limiting engaged (${rateLimited} gateway rejections, ${rate.denied} local defers)`,
      detail: `Quota is ${rate.refillPerSec} QPS per app_key; peak seen ${rate.peakPerSec}/s.`,
      action: 'Lower the QPS setting, spread calls, or request a quota increase from partner@temu.com.',
      value: rateLimited,
    });
  }

  // 5. Ads efficiency.
  if (dashboard.ads && dashboard.ads.spend > 0) {
    if (dashboard.ads.roas < settings.alerts.minRoas) {
      push({
        rule: 'roas-low', severity: 'warning', metric: 'roas',
        title: `ROAS ${dashboard.ads.roas}× is below the ${settings.alerts.minRoas}× floor`,
        detail: `Spend ${dashboard.ads.spend} returned ${dashboard.ads.adGmv} in ad-attributed GMV.`,
        action: 'Move budget off the worst goods (see Ads → by goods) or cut ACOS-heavy campaigns.',
        value: dashboard.ads.roas,
      });
    }
    if (dashboard.ads.acos > settings.alerts.maxAcos) {
      push({
        rule: 'acos-high', severity: 'info', metric: 'acos',
        title: `ACOS ${dashboard.ads.acos}% above the ${settings.alerts.maxAcos}% ceiling`,
        detail: `Ad cost is ${dashboard.ads.acos}% of ad-attributed GMV.`,
        action: 'Check which goods have ROAS < 1.5 and pause them.',
        value: dashboard.ads.acos,
      });
    }
  }

  // 6. Fulfilment aging.
  if (dashboard.kpis.agedUnshipped > 0) {
    push({
      rule: 'unshipped-aging', severity: 'critical', metric: 'fulfillment',
      title: `${dashboard.kpis.agedUnshipped} order(s) unshipped beyond ${settings.alerts.unshippedAgeHours}h`,
      detail: `Oldest unshipped order is ${dashboard.kpis.oldestUnshippedHours}h old. Late shipment affects store rating.`,
      action: 'Filter Orders by status "Pending shipment" and ship or cancel.',
      value: dashboard.kpis.agedUnshipped,
    });
  }

  // 7. Refund rate.
  if (dashboard.kpis.refundRatePct > settings.alerts.refundRatePct) {
    push({
      rule: 'refund-rate', severity: 'info', metric: 'refunds',
      title: `Refund rate ${dashboard.kpis.refundRatePct}% above ${settings.alerts.refundRatePct}%`,
      detail: `${dashboard.kpis.refunds} ${dashboard.currency} refunded across ${dashboard.kpis.orders} orders.`,
      action: 'Cross-check the top refunded goods in the returns report.',
      value: dashboard.kpis.refundRatePct,
    });
  }

  // 8. Partial data — always tell the truth about coverage.
  if (dashboard.kpis.amountCoveragePct < 100 && dashboard.kpis.orders > 0) {
    push({
      rule: 'amount-coverage', severity: 'info', metric: 'coverage',
      title: `Amounts fetched for ${dashboard.kpis.pricedOrders}/${dashboard.kpis.orders} orders`,
      detail: 'The order list API returns no money; GMV/settlement are computed from temu.order.amount.v2.query per parent order.',
      action: 'Raise "Amount lookups" in Settings to price more orders (each one costs 1 API call).',
      value: dashboard.kpis.amountCoveragePct,
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
}
