/**
 * app.js — the dashboard UI (vanilla JS, no build step).
 * Everything talks to the local API with relative URLs, so it works identically
 * on localhost and behind a sandbox/proxy preview.
 */
import { lineChart, barChart, barList, funnel, sparkline, fmt, esc } from './charts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  boot: null,
  report: null,
  catalog: null,
  tab: 'overview',
  loading: false,
  progress: null,
  ep: { cat: 'all', q: '', selected: null, params: {}, view: 'request', result: null, sending: false, simulate: '' },
  requests: null,
  inbox: null,
  csvSummary: null,
  settings: {},
  modal: null,
  openOrder: null,
};

const TABS = [
  ['overview', 'Overview'],
  ['orders', 'Orders'],
  ['ads', 'Ads & funnel'],
  ['explorer', 'API explorer'],
  ['requests', 'Request log'],
  ['webhooks', 'Webhooks'],
  ['import', 'Import export'],
  ['settings', 'Settings'],
];

/* ------------------------------------------------------------------ helpers */
async function api(path, { method = 'GET', body, header = true } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(header ? { 'x-dashboard': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { __raw: text }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.append(el);
  setTimeout(() => el.remove(), 5200);
}

const copy = async (text, label = 'Copied') => {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch {
    toast('Clipboard blocked by the browser — select the text manually', 'err');
  }
};

/* --------------------------------------------------------------- data load */
async function boot() {
  state.loading = true;
  render();
  try {
    state.boot = await api('/api/state', { header: false });
    state.settings = { ...state.boot.settings };
    await loadCatalog();
    await loadReport();
  } catch (err) {
    toast(`Startup failed: ${err.message}`, 'err');
  } finally {
    state.loading = false;
    render();
  }
}

async function loadCatalog() {
  const cat = await api('/api/catalog', { header: false });
  state.catalog = cat;
}

async function loadReport({ force = false, amountLookups, adsDays, days } = {}) {
  state.loading = true;
  state.progress = 4;
  render();
  try {
    const q = new URLSearchParams();
    if (force) q.set('force', '1');
    if (amountLookups) q.set('amountLookups', String(amountLookups));
    if (adsDays) q.set('adsDays', String(adsDays));
    if (days) q.set('days', String(days));
    state.report = await api(`/api/report?${q}`, { header: false });
  } catch (err) {
    toast(`Report failed: ${err.message}`, 'err');
  } finally {
    state.loading = false;
    state.progress = null;
    render();
  }
}

/** Refresh with live progress from the SSE endpoint. */
async function refreshWithProgress() {
  state.loading = true;
  state.progress = 4;
  render();
  await new Promise((resolve) => {
    const es = new EventSource('/api/report/stream?force=1');
    es.addEventListener('progress', (e) => {
      const ev = JSON.parse(e.data);
      state.progress = Math.max(ev.pct || 0, state.progress || 0);
      state.progressLabel = ev.step;
      render();
    });
    es.addEventListener('report', (e) => {
      state.report = JSON.parse(e.data);
    });
    es.addEventListener('done', () => { es.close(); resolve(); });
    es.addEventListener('error', () => { es.close(); toast('Stream ended early', 'err'); resolve(); });
    setTimeout(() => { es.close(); resolve(); }, 90_000);
  });
  state.loading = false;
  state.progress = null;
  render();
}

/* ------------------------------------------------------------------ render */
function render() {
  renderTop();
  renderTabs();
  const main = $('#main');
  const r = state.report;
  if (state.loading && !r) {
    main.innerHTML = `<div class="grid kpis">${Array.from({ length: 4 }, () => '<div class="skeleton"></div>').join('')}</div><div class="skeleton" style="height:280px"></div>`;
    return;
  }
  const views = {
    overview: viewOverview, orders: viewOrders, ads: viewAds, explorer: viewExplorer,
    requests: viewRequests, webhooks: viewWebhooks, import: viewImport, settings: viewSettings,
  };
  main.innerHTML = (views[state.tab] || viewOverview)();
  // Charts are drawn after the markup exists (plain SVG injection).
  if (state.tab === 'overview') drawCharts();
  if (state.tab === 'ads') drawAdsCharts();
}

function renderTop() {
  const r = state.report;
  const s = state.settings;
  const adapter = r?.adapter;
  const pills = [];
  pills.push(`<span class="pill ${adapter?.id === 'mock' ? 'orange' : adapter?.configured ? '' : 'err'}"><i class="dot"></i>${esc(adapter?.id || s.adapter || '—')} adapter</span>`);
  pills.push(`<span class="pill info">${esc(s.region || 'US')} · ${esc(r?.adapter?.host?.replace('https://', '') || '')}</span>`);
  if (r?.dashboard?.currency) pills.push(`<span class="pill">${esc(r.dashboard.currency)}</span>`);
  if (r?.cached) pills.push(`<span class="pill">cached ${Math.round((r.cacheAgeMs || 0) / 1000)}s</span>`);
  if (s.appKey) pills.push(`<span class="pill mono">app_key ${esc(String(s.appKey).slice(0, 8))}…</span>`);
  const alertCount = r?.alerts?.filter((a) => a.severity === 'critical').length || 0;

  $('#top').innerHTML = `
    <div class="brand">
      <div class="logo">T</div>
      <div style="min-width:0">
        <h1>Temu Partner API — developer dashboard</h1>
        <div class="sub">Free &amp; self-hosted · signed requests, live metrics, webhook verification${r?.builtAt ? ` · built ${new Date(r.builtAt).toLocaleTimeString()}` : ''}</div>
      </div>
    </div>
    <div class="top-actions">
      ${pills.join('')}
      ${alertCount ? `<span class="pill err">${alertCount} critical</span>` : ''}
      <button class="btn" data-act="tab" data-tab="settings">⚙ Settings</button>
      <button class="btn primary" data-act="refresh" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Working…' : '↻ Refresh data'}</button>
    </div>`;
}

function renderTabs() {
  const counts = {
    orders: state.report?.dashboard?.kpis?.orders,
    explorer: state.catalog?.endpoints?.length,
    requests: state.report?.requests?.stats?.total,
  };
  $('#tabs').innerHTML = TABS.map(([id, label]) => `
    <button data-act="tab" data-tab="${id}" class="${state.tab === id ? 'active' : ''}">
      ${label}${counts[id] ? `<span class="badge">${counts[id]}</span>` : ''}
    </button>`).join('');
}

/* --------------------------------------------------------------- overview */
function viewOverview() {
  const r = state.report;
  if (!r) return '<div class="empty">No report yet. Click “Refresh data”.</div>';
  const d = r.dashboard;
  const k = d.kpis;
  const cur = d.currency;
  const ads = d.ads;

  const alerts = renderAlerts(r.alerts);
  const currencyNote = d.mixedCurrency
    ? `<div class="banner warn">💱 <div><b>Mixed currencies in this window.</b> Totals are shown in ${esc(cur)} (the dominant market). ${d.currencies.map((c) => `${esc(c.currency)} ${fmt.num(c.orders)} orders / ${fmt.money(c.gmv, c.currency)}`).join(' · ')}. Set a reporting currency in Settings to force a single display currency — FX conversion is deliberately not invented.</div></div>`
    : '';
  const banner = r.adapter.id === 'mock'
    ? `<div class="banner">🧪 <div><b>Mock adapter.</b> Synthetic orders and ads, generated locally, pushed through the <b>real</b> signing + envelope + error-code path — so the pipeline you see here is the pipeline that runs live. Add credentials in Settings to switch to the live Partner API.</div></div>`
    : r.adapter.id === 'csv'
      ? `<div class="banner warn">📄 <b>CSV import adapter.</b> affiliate exports have no public API; these numbers come from the file you imported.</div>`
      : `<div class="banner">🛰️ <b>Live Partner API.</b> ${esc(r.adapter.host)} · token scopes checked · amounts fetched for ${k.pricedOrders}/${k.orders} orders.</div>`;

  const kpis = [
    kpi('GMV (priced orders)', fmt.money(k.gmv, cur), `${k.pricedOrders} of ${k.orders} orders priced · AOV ${fmt.money(k.aov, cur)}`, d.series.map((s) => s.gmv)),
    kpi(d.csv ? 'Commission (imported)' : 'Est. settlement', fmt.money(k.settlement, cur), d.csv ? `from ${d.csv.rowCount} imported rows · rate ${fmt.pct(d.csv.derived?.commissionRate || 0)}` : `deductions ${fmt.money(k.deductions, cur)} · ${fmt.pct(k.amountCoveragePct, 0)} coverage`, d.series.map((s) => s.settlement), 'good'),
    kpi('Ad spend → ROAS', `${fmt.money(ads?.spend || 0, cur)} → ${fmt.ratio(ads?.roas || 0)}`, `ACOS ${fmt.pct(ads?.acos || 0)} · ${fmt.num(ads?.clicks || 0)} clicks`, d.series.map((s) => s.adSpend), (ads?.roas || 0) >= (state.settings.alerts?.minRoas || 2) ? 'good' : 'bad'),
    kpi(`${d.earnings.mode === 'imported' ? 'Commission (imported)' : 'Commission projection'}`, fmt.money(d.earnings.commission, cur), `${d.earnings.label} · EPC ${fmt.money(d.earnings.epc, cur, 2)}`, d.series.map((s) => s.settlement)),
    kpi('Units / orders', `${fmt.num(k.units)} / ${fmt.num(k.orders)}`, `${fmt.num(k.unshipped)} unshipped · ${k.agedUnshipped ? `${k.agedUnshipped} aging` : 'none aging'}`, d.series.map((s) => s.units), k.agedUnshipped ? 'warnv' : ''),
    kpi('Refund / cancel rate', `${fmt.pct(k.refundRatePct)} / ${fmt.pct(k.cancelRatePct)}`, `refunds ${fmt.money(k.refunds, cur)}`, d.series.map((s) => s.refunds), k.refundRatePct > (state.settings.alerts?.refundRatePct || 8) ? 'warnv' : ''),
  ].join('');

  const roasSeries = d.series.map((s) => (s.adSpend ? s.adGmv / s.adSpend : 0));

  return `
    ${banner}${currencyNote}${alerts}
    <div class="grid kpis">${kpis}</div>

    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><div><h3>Money per day</h3><p class="hint">GMV, estimated settlement and ad spend for the collected window (${d.series.length} days).</p></div></div>
        <div id="chart-money-slot"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>ROAS &amp; ACOS</h3><p class="hint">Blended return on ad spend vs ad cost ratio.</p></div></div>
        <div id="chart-roas-slot"></div>
        <h3 style="margin-top:14px">Traffic funnel</h3>
        ${funnel(d.funnel)}
      </div>
    </div>

    <div class="grid cols-3">
      <div class="card">
        <div class="card-head"><div><h3>Revenue by market</h3><p class="hint">Grouped from order site IDs.</p></div></div>
        ${barList(d.regions.map((x) => ({ name: x.name, value: x.gmv || x.orders })), { color: '#5aa9ff', format: (v) => fmt.money(v, cur) })}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Top goods by units</h3><p class="hint">${d.topGoods.some((g) => g.adSpend) ? 'Seller orders + ad performance.' : 'Seller orders.'}</p></div></div>
        ${barList(d.topGoods.map((g) => ({ name: g.goodsName, value: g.units })), { color: '#a78bfa', max: 7 })}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Order pipeline</h3><p class="hint">Status distribution (labels inferred from the order-status codes).</p></div></div>
        ${barList(d.statusBreakdown.map((s) => ({ name: s.name, value: s.orders })), { color: '#37d39b', max: 8 })}
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <div class="card-head"><div><h3>Data pipeline health</h3><p class="hint">Where the numbers came from and what failed.</p></div></div>
        ${renderHealth(d)}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Token &amp; authorisation</h3><p class="hint">bg.open.accesstoken.info.get</p></div></div>
        ${renderToken(r)}
      </div>
    </div>`;
}

function kpi(label, value, foot, spark, cls = '') {
  return `<div class="card kpi ${cls}">
    <div class="label">${label}${spark?.length ? `<span class="spacer"></span>${sparkline(spark.slice(-14))}` : ''}</div>
    <div class="value">${value}</div>
    <div class="foot">${esc(foot)}</div>
  </div>`;
}

function renderAlerts(alerts) {
  if (!alerts?.length) {
    return `<div class="alert info"><span class="ico">✅</span><div class="body"><strong>No alerts</strong><p>Token healthy, scopes present, rate limit under control, ads above your floors.</p></div></div>`;
  }
  const icon = { critical: '⛔', warning: '⚠️', info: 'ℹ️' };
  return `<div class="alerts">${alerts.map((a) => `
    <div class="alert ${a.severity}">
      <span class="ico">${icon[a.severity] || 'ℹ️'}</span>
      <div class="body">
        <strong>${esc(a.title)}</strong>
        ${a.detail ? `<p>${esc(a.detail)}</p>` : ''}
        ${a.action ? `<div class="act">→ ${esc(a.action)}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function renderHealth(d) {
  const errors = d.health.errors || [];
  const timings = Object.entries(d.health.timings || {});
  return `
    <div class="row" style="margin-bottom:10px">
      <span class="pill ${errors.length ? 'warn' : ''}">${errors.length} pipeline error(s)</span>
      ${timings.map(([k, v]) => `<span class="pill mono">${esc(k)} ${v}ms</span>`).join('')}
    </div>
    ${errors.length
      ? `<div class="table-wrap" style="max-height:150px"><table><thead><tr><th>Step</th><th>Code</th><th>Message</th></tr></thead><tbody>
          ${errors.map((e) => `<tr><td class="mono">${esc(e.step)}</td><td class="mono">${esc(e.errorCode ?? '')}</td><td class="wrap">${esc(e.error?.meaning || e.errorMsg)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">All pipeline steps returned 1000000 (SUCCESS).</p>'}
    <p class="hint" style="margin-top:10px">Amount coverage ${d.kpis.pricedOrders}/${d.kpis.orders} orders. GMV and settlement are computed only from orders whose amounts were fetched — the order list endpoint carries no money fields.</p>`;
}

function renderToken(r) {
  const t = r.dashboard.tokenInfo || null;
  const scopes = t?.apiScopeList || [];
  const expiry = t?.expiredTime ? new Date(Number(t.expiredTime) * 1000) : null;
  const hours = expiry ? Math.round((expiry - Date.now()) / 3600_000) : null;
  if (!t) return '<p class="hint">Token info not available (scope or credentials missing). The dashboard degrades one panel at a time instead of failing whole pages.</p>';
  return `
    <div class="row" style="margin-bottom:10px">
      <span class="pill ${hours !== null && hours < (state.settings.alerts?.tokenExpiryHours || 72) ? 'warn' : ''}">expires ${expiry ? expiry.toISOString().replace('T', ' ').slice(0, 16) : '—'}Z${hours !== null ? ` (${hours}h)` : ''}</span>
      <span class="pill">mallId ${esc(t.mallId ?? '—')}</span>
      <span class="pill">mallType ${esc(t.mallType ?? '—')}</span>
      <span class="pill">regionId ${esc(t.regionId ?? '—')}</span>
    </div>
    <p class="hint" style="margin-bottom:8px">${scopes.length} authorised API scope(s):</p>
    <div class="row" style="gap:5px">${scopes.slice(0, 14).map((s) => `<span class="chip mono" style="cursor:default">${esc(s)}</span>`).join('')}${scopes.length > 14 ? `<span class="chip" style="cursor:default">+${scopes.length - 14}</span>` : ''}</div>
    <details class="help"><summary>Subscribed webhook events (${(t.appSubscribeEventCodeList || []).length})</summary>
      <div class="mono dim">${(t.appSubscribeEventCodeList || []).map(esc).join('<br>') || 'none'}</div>
    </details>`;
}

function drawCharts() {
  const d = state.report?.dashboard;
  if (!d) return;
  const labels = d.series.map((s) => s.date);
  const cur = d.currency;
  const money = $('#chart-money-slot');
  if (money) {
    money.innerHTML = lineChart({
      labels,
      currency: cur,
      valueFormat: (v) => fmt.money(v, cur),
      series: [
        { name: 'GMV', color: '#ff7a45', values: d.series.map((s) => s.gmv), area: true },
        { name: 'Settlement', color: '#37d39b', values: d.series.map((s) => s.settlement), area: true },
        { name: 'Ad spend', color: '#5aa9ff', values: d.series.map((s) => s.adSpend) },
      ],
    });
  }
  const roas = $('#chart-roas-slot');
  if (roas) {
    roas.innerHTML = lineChart({
      labels,
      valueFormat: (v) => v.toFixed(1),
      series: [
        { name: 'ROAS ×', color: '#a78bfa', values: d.series.map((s) => (s.adSpend ? Math.round((s.adGmv / s.adSpend) * 100) / 100 : 0)), area: true },
        { name: 'ACOS %', color: '#ffc857', values: d.series.map((s) => (s.adGmv ? Math.round((s.adSpend / s.adGmv) * 10000) / 100 : 0)) },
      ],
    });
  }
}

/* ------------------------------------------------------------------ orders */
function viewOrders() {
  const r = state.report;
  if (!r) return '<div class="empty">No report yet.</div>';
  const orders = r.dashboard.orders || [];
  const cur = r.dashboard.currency;
  const statuses = [...new Set(orders.map((o) => o.statusLabel))];
  const filter = state.orderFilter || { status: 'all', q: '' };
  const rows = orders.filter((o) =>
    (filter.status === 'all' || o.statusLabel === filter.status) &&
    (!filter.q || o.parentOrderSn.toLowerCase().includes(filter.q.toLowerCase()) || (o.items || []).some((i) => (i.goodsName || '').toLowerCase().includes(filter.q.toLowerCase()))));

  const openDetail = state.openOrder ? orders.find((o) => o.parentOrderSn === state.openOrder) : null;

  return `
    <div class="card" style="margin-bottom:14px">
      <div class="row">
        <span class="pill">${orders.length} parent orders</span>
        <span class="pill info">${orders.filter((o) => o.priced).length} priced</span>
        <span class="pill">${fmt.num(orders.reduce((s, o) => s + (o.itemCount || 0), 0))} units</span>
        <select id="order-status" style="width:auto">${['all', ...statuses].map((s) => `<option ${filter.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <input id="order-q" type="text" placeholder="Search order SN or goods…" value="${esc(filter.q)}" style="width:280px"/>
        <span class="spacer"></span>
        <button class="btn small" data-act="copy" data-copy="${esc(JSON.stringify(orders.slice(0, 50), null, 1))}">Copy JSON (50)</button>
      </div>
      <p class="hint" style="margin-top:9px">Click a row for the amount breakdown returned by <code class="mono">temu.order.amount.v2.query</code> (customerPaid vs salesProceeds).</p>
    </div>

    <div class="card">
      <div class="table-wrap" style="max-height:640px">
        <table>
          <thead><tr>
            <th>Parent order</th><th>Status</th><th>Market</th><th>Created</th><th class="right">Items</th>
            <th class="right">GMV</th><th class="right">Settlement</th><th class="right">Fees</th><th>Ads</th><th></th>
          </tr></thead>
          <tbody>
            ${rows.slice(0, 300).map((o) => `
              <tr data-act="open-order" data-sn="${esc(o.parentOrderSn)}" style="cursor:pointer">
                <td class="mono">${esc(o.parentOrderSn)}</td>
                <td><span class="status-code ${o.status === 5 || o.status === 4 ? 'err' : 'ok'}">${esc(o.statusLabel)}</span></td>
                <td>${esc(o.siteName)}</td>
                <td class="dim mono">${fmt.when(o.created)}</td>
                <td class="right">${fmt.num(o.itemCount)}</td>
                <td class="right mono">${o.priced ? fmt.money(o.gmv, o.currency || cur, 2) : '<span class="dim">—</span>'}</td>
                <td class="right mono">${o.priced ? fmt.money(o.settlement, o.currency || cur, 2) : '<span class="dim">—</span>'}</td>
                <td class="right mono dim">${o.priced ? fmt.money(o.deduction, o.currency || cur, 2) : '—'}</td>
                <td>${o.adsAttributed ? '<span class="pill orange" style="padding:2px 7px">ads</span>' : '<span class="dim">organic</span>'}</td>
                <td class="dim">›</td>
              </tr>`).join('') || '<tr><td colspan="10" class="empty">No orders match this filter.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    ${openDetail ? renderOrderModal(openDetail) : ''}`;
}

function renderOrderModal(o) {
  const money = (v, cur) => (v === null || v === undefined ? '<span class="dim">—</span>' : fmt.money(v, cur, 2));
  return `<div class="overlay" data-act="close-modal">
    <div class="modal" data-stop="1">
      <div class="card-head">
        <div>
          <h2 class="mono" style="font-size:15px">${esc(o.parentOrderSn)}</h2>
          <p class="hint">${esc(o.statusLabel)} · ${esc(o.siteName)} · created ${fmt.when(o.created)}${o.shippedAt ? ` · shipped ${fmt.when(o.shippedAt)}` : ''}</p>
        </div>
        <button class="btn small" data-act="close-modal">Close</button>
      </div>
      <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
        <div class="kpi"><span class="label">Customer paid</span><span class="value" style="font-size:19px">${money(o.gmv, o.currency)}</span></div>
        <div class="kpi"><span class="label">Settlement</span><span class="value" style="font-size:19px;color:var(--green)">${money(o.settlement, o.currency)}</span></div>
        <div class="kpi"><span class="label">Deductions</span><span class="value" style="font-size:19px;color:var(--amber)">${money(o.deduction, o.currency)}</span></div>
      </div>
      <table style="margin-bottom:12px">
        <thead><tr><th>Item</th><th>Spec</th><th class="right">Qty</th><th>Fulfilment</th></tr></thead>
        <tbody>${(o.items || []).map((i) => `<tr><td class="wrap">${esc(i.goodsName)}<div class="dim mono" style="font-size:11px">goodsId ${esc(i.goodsId)} · skuId ${esc(i.skuId)}</div></td><td class="dim">${esc(i.spec || '—')}</td><td class="right">${fmt.num(i.quantity)}</td><td class="dim">${esc(i.fulfillmentType || '—')}</td></tr>`).join('')}</tbody>
      </table>
      ${o.warning?.length ? `<div class="banner warn">⚠️ Gateway warnings: ${o.warning.map(esc).join(', ')}</div>` : ''}
      <div class="row">
        <button class="btn small" data-act="copy" data-copy="${esc(JSON.stringify(o, null, 1))}">Copy order JSON</button>
        <button class="btn small" data-act="explore-type" data-type="temu.order.amount.v2.query" data-param="parentOrderSn" data-value="${esc(o.parentOrderSn)}">Open in explorer</button>
      </div>
    </div>
  </div>`;
}

/* --------------------------------------------------------------------- ads */
function viewAds() {
  const r = state.report;
  if (!r) return '<div class="empty">No report yet.</div>';
  const d = r.dashboard;
  const ads = d.ads;
  const cur = d.currency;
  if (!ads) {
    return `<div class="card"><h3>No ads data</h3><p class="hint">The ads report returned nothing — usually a missing <code class="mono">temu.searchrec.ad.reports.mall.query</code> scope, or this account does not run Search &amp; Recommendation ads.</p></div>`;
  }
  const goods = d.topGoods.filter((g) => g.adSpend);
  return `
    <div class="grid kpis" style="margin-bottom:14px">
      ${kpi('Ad spend', fmt.money(ads.spend, cur), `${fmt.num(ads.impressions)} impressions`, null)}
      ${kpi('Ad-attributed GMV', fmt.money(ads.adGmv, cur), `${fmt.num(ads.orders)} paid orders`, null)}
      ${kpi('ROAS', fmt.ratio(ads.roas), `floor ${fmt.ratio(state.settings.alerts?.minRoas ?? 2)}`, null, ads.roas >= (state.settings.alerts?.minRoas ?? 2) ? 'good' : 'bad')}
      ${kpi('ACOS', fmt.pct(ads.acos), `ceiling ${fmt.pct(state.settings.alerts?.maxAcos ?? 45)}`, null, ads.acos <= (state.settings.alerts?.maxAcos ?? 45) ? 'good' : 'bad')}
      ${kpi('CTR / CVR', `${fmt.pct(ads.ctr, 2)} / ${fmt.pct(ads.cvr, 2)}`, `CPC ${fmt.money(ads.cpc, cur, 2)} · CPM ${fmt.money(ads.cpm, cur, 2)}`, null)}
      ${kpi('EPC', fmt.money(ads.epc, cur, 3), 'ad GMV per click', null)}
    </div>
    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><div><h3>Daily spend vs attributed GMV</h3><p class="hint">One mall-report call per day window.</p></div></div>
        <div id="ads-daily-slot"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Funnel</h3><p class="hint">Impressions → clicks → carts → paid orders.</p></div></div>
        ${funnel(d.funnel)}
        <details class="help" style="margin-top:14px"><summary>How the funnel maps to the API</summary>
          <div class="hint">imprCnt, clkCnt, cartCnt, orderPayCnt from <code class="mono">temu.searchrec.ad.reports.mall.query</code>, each returned as <code class="mono">{ total, ad, netTotal, netAd }</code> with a <code class="mono">val</code> inside.</div>
        </details>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Performance by goods</h3><p class="hint">temu.searchrec.ad.reports.goods.query — the table that tells you what to pause.</p></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Goods</th><th class="right">Impr.</th><th class="right">Clicks</th><th class="right">CTR</th><th class="right">Spend</th><th class="right">Ad GMV</th><th class="right">Orders</th><th class="right">ROAS</th><th class="right">ACOS</th></tr></thead>
          <tbody>${(r.dashboard.topGoods || []).filter((g) => g.adSpend || g.units).map((g) => `
            <tr>
              <td class="wrap">${esc(g.goodsName)}<div class="dim mono" style="font-size:10.5px">${esc(g.goodsId)}</div></td>
              <td class="right mono">${g.impressions ? fmt.num(g.impressions) : '<span class="dim">—</span>'}</td>
              <td class="right mono">${g.clicks ? fmt.num(g.clicks) : '<span class="dim">—</span>'}</td>
              <td class="right mono">${g.ctr ? fmt.pct(g.ctr, 2) : '<span class="dim">—</span>'}</td>
              <td class="right mono">${g.adSpend ? fmt.money(g.adSpend, cur, 2) : '<span class="dim">—</span>'}</td>
              <td class="right mono">${g.adGmv ? fmt.money(g.adGmv, cur, 2) : '<span class="dim">—</span>'}</td>
              <td class="right mono">${fmt.num(g.orders)}</td>
              <td class="right mono" style="color:${g.roas && g.roas < 1.5 ? 'var(--red)' : 'var(--green)'}">${g.roas ? fmt.ratio(g.roas) : '—'}</td>
              <td class="right mono">${g.roas ? fmt.pct((1 / g.roas) * 100) : '—'}</td>
            </tr>`).join('') || '<tr><td colspan="9" class="empty">No goods-level ad data.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

function drawAdsCharts() {
  const d = state.report?.dashboard;
  if (!d?.ads) return;
  const slot = $('#ads-daily-slot');
  if (!slot) return;
  const labels = d.series.map((s) => s.date);
  const cur = d.currency;
  slot.innerHTML = lineChart({
    labels, height: 240, valueFormat: (v) => fmt.money(v, cur),
    series: [
      { name: 'Ad spend', color: '#ff7a45', values: d.series.map((s) => s.adSpend), area: true },
      { name: 'Ad GMV', color: '#37d39b', values: d.series.map((s) => s.adGmv), area: true },
    ],
  });
}

/* ---------------------------------------------------------------- explorer */
function viewExplorer() {
  const cat = state.catalog;
  if (!cat) return '<div class="empty">Catalogue not loaded.</div>';
  const { cat: _c, q } = state.ep;
  const categories = ['all', ...Object.keys(cat.categories).sort()];
  const filtered = cat.endpoints.filter((e) =>
    (state.ep.cat === 'all' || e.category === state.ep.cat) &&
    (!q || e.name.toLowerCase().includes(q.toLowerCase()) || (e.title || '').toLowerCase().includes(q.toLowerCase())));

  const sel = state.ep.selected ? cat.endpoints.find((e) => e.name === state.ep.selected) : filtered[0];
  const view = state.ep.view;
  return `
    <div class="banner">🔎 <div><b>${cat.endpoints.length} endpoints</b> from the Partner API reference (${Object.keys(cat.categories).length} categories). Preview the exact signed body, pre-sign string and curl before a single call leaves your machine. Default quota: <b>${cat.gateway.rateLimitQps} QPS</b> per app_key.</div></div>
    <div class="explorer">
      <div class="card">
        <input id="ep-q" type="text" placeholder="Search endpoints…" value="${esc(q)}" style="margin-bottom:9px"/>
        <div class="cat-filter">
          ${categories.map((c) => `<button class="chip ${state.ep.cat === c ? 'active' : ''}" data-act="ep-cat" data-cat="${esc(c)}">${esc(c)}${c !== 'all' ? ` ${cat.categories[c]}` : ''}</button>`).join('')}
        </div>
        <div class="ep-list">
          ${filtered.map((e) => `<button class="ep-item ${sel?.name === e.name ? 'active' : ''}" data-act="ep-select" data-name="${esc(e.name)}">
            <div class="name">${esc(e.name)}</div>
            <div class="cat">${esc(e.title || '')} · ${e.params.length} params${e.errors.length ? ` · ${e.errors.length} error codes` : ''}</div>
          </button>`).join('') || '<div class="empty">No endpoint matches.</div>'}
        </div>
      </div>
      <div class="card">
        ${sel ? renderEndpoint(sel, view) : '<div class="empty">Select an endpoint.</div>'}
      </div>
    </div>`;
}

function renderEndpoint(ep, view) {
  const p = state.ep.params;
  const preview = state.ep.preview;
  const result = state.ep.result;

  const paramForm = ep.params.length
    ? `<div class="params">${ep.params.map((f) => {
        const value = p[f.name] ?? '';
        const type = f.type === 'ARRAY' ? 'array' : ['INTEGER', 'LONG', 'FLOAT'].includes(f.type) ? 'number' : 'text';
        return `<div class="param">
          <label title="${esc(f.description || '')}">${esc(f.name)}${f.required ? ' *' : ''}</label>
          <input data-act="ep-param" data-name="${esc(f.name)}" data-type="${type}" type="text" value="${esc(value)}" placeholder="${esc(f.type)}${f.required ? ' (required)' : ''}"/>
          <div class="meta">${esc(f.type)}${f.description ? ` · ${esc(f.description.slice(0, 60))}` : ''}</div>
        </div>`;
      }).join('')}</div>`
    : '<p class="hint" style="margin-bottom:12px">This endpoint takes only the common parameters.</p>';

  const tabs = ['request', 'sign', 'curl', 'response', 'docs'];
  return `
    <div class="card-head">
      <div style="min-width:0">
        <h3 class="mono" style="font-size:14px">${esc(ep.name)}</h3>
        <p class="hint">${esc(ep.title || '')} · <span class="pill info" style="padding:2px 7px">POST</span> ${esc(ep.url.replace('https://', ''))} · category <b>${esc(ep.category)}</b></p>
      </div>
    </div>
    <p class="hint" style="margin-bottom:12px">${esc(ep.description || '')}</p>
    ${paramForm}
    <div class="row" style="margin-bottom:12px">
      <button class="btn" data-act="ep-preview">Preview signed request</button>
      <button class="btn primary" data-act="ep-send" ${state.ep.sending ? 'disabled' : ''}>${state.ep.sending ? 'Sending…' : 'Send it'}</button>
      <select id="ep-simulate" style="width:auto">
        <option value="">no error simulation</option>
        <option value="RATE_LIMIT" ${state.ep.simulate === 'RATE_LIMIT' ? 'selected' : ''}>simulate 4000004 rate limit</option>
        <option value="SIGN_INVALID" ${state.ep.simulate === 'SIGN_INVALID' ? 'selected' : ''}>simulate 3000001 bad sign</option>
        <option value="SCOPE" ${state.ep.simulate === 'SCOPE' ? 'selected' : ''}>simulate 3000032 missing scope</option>
        <option value="TOKEN" ${state.ep.simulate === 'TOKEN' ? 'selected' : ''}>simulate 3000034 expired token</option>
        <option value="SYSTEM" ${state.ep.simulate === 'SYSTEM' ? 'selected' : ''}>simulate 4000000 system error</option>
        <option value="IP" ${state.ep.simulate === 'IP' ? 'selected' : ''}>simulate 5000003 IP not allowed</option>
      </select>
      ${state.report?.adapter?.id === 'partner' ? '<span class="pill warn">live credentials — this call hits Temu</span>' : '<span class="pill">mock gateway</span>'}
    </div>
    <div class="tabs-mini">
      ${tabs.map((t) => `<button class="${view === t ? 'active' : ''}" data-act="ep-view" data-view="${t}">${t}</button>`).join('')}
    </div>
    ${view === 'request' && `<pre class="code">${preview ? esc(JSON.stringify(preview.body, null, 2)) : '// Click “Preview signed request”'}</pre>`}
    ${view === 'sign' && (preview
      ? `<pre class="code">${esc(`sign string (app_secret wrapped head+tail, keys sorted, values concatenated):
${preview.signString}

MD5(sign string).toUpperCase():
${preview.sign}`)}</pre>`
      : '<pre class="code">// Click “Preview signed request”</pre>')}
    ${view === 'curl' && `<pre class="code">${preview ? esc(curlFor(preview)) : '// Click “Preview signed request”'}</pre>`}
    ${view === 'response' && (result
      ? `<div class="row" style="margin-bottom:8px">
          <span class="status-code ${result.ok ? 'ok' : 'err'}">${result.ok ? 'success 1000000' : `errorCode ${esc(result.errorCode)}`}</span>
          <span class="pill">${result.meta?.latencyMs ?? 0}ms</span>
          <span class="pill">attempt ${result.meta?.attempts ?? 1}</span>
          ${result.error ? `<span class="pill err">${esc(result.error.meaning)}</span>` : ''}
        </div>
        ${result.error ? `<div class="alert warning"><span class="ico">ℹ️</span><div class="body"><strong>${esc(result.error.meaning)}</strong><p>${esc(result.error.hint)}</p></div></div>` : ''}
        <pre class="code tall">${esc(JSON.stringify(result.raw ?? result.result, null, 2))}</pre>`
      : ep.responseExample
        ? `<p class="hint" style="margin-bottom:8px">Documented response example (no call made yet):</p><pre class="code tall">${esc(ep.responseExample)}</pre>`
        : '<pre class="code">// Send the request to see a response</pre>')}
    ${view === 'docs' && `
      <p class="hint">Parameter schema${ep.params.length ? '' : ' (none)'} and endpoint-specific error codes.</p>
      ${ep.errors.length ? `<table style="margin-top:10px"><thead><tr><th>Code</th><th>Message</th></tr></thead><tbody>
        ${ep.errors.map((e) => `<tr><td class="mono">${esc(e.code)}</td><td class="wrap">${esc(e.message)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="hint" style="margin-top:8px">No endpoint-specific error codes documented.</p>'}`}
  `;
}

const curlFor = (preview) =>
  `curl -X POST '${preview.host}' \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(preview.body, null, 2)}'`;

async function epPreview() {
  const ep = currentEndpoint();
  if (!ep) return;
  try {
    const out = await api('/api/playground', { method: 'POST', body: { type: ep.name, params: buildParams(ep) } });
    state.ep.preview = out.preview;
    state.ep.view = 'request';
    render();
  } catch (err) { toast(err.message, 'err'); }
}

async function epSend() {
  const ep = currentEndpoint();
  if (!ep) return;
  state.ep.sending = true;
  render();
  try {
    const out = await api('/api/playground', {
      method: 'POST',
      body: { type: ep.name, params: buildParams(ep), send: true, simulate: state.ep.simulate || undefined },
    });
    state.ep.preview = out.preview;
    state.ep.result = out.result;
    state.ep.view = 'response';
    toast(out.result.ok ? `${ep.name} → 1000000 SUCCESS` : `${ep.name} → ${out.result.errorCode}`, out.result.ok ? 'ok' : 'err');
    const reqs = await api('/api/requests?limit=50', { header: false });
    state.requests = reqs;
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.ep.sending = false;
    render();
  }
}

function currentEndpoint() {
  const cat = state.catalog;
  if (!cat) return null;
  return cat.endpoints.find((e) => e.name === state.ep.selected) || cat.endpoints.find((e) => e.name === 'bg.order.list.v2.get');
}

function buildParams(ep) {
  const out = {};
  for (const f of ep.params) {
    const raw = state.ep.params[f.name];
    if (raw === undefined || raw === '') continue;
    if (f.type === 'ARRAY') out[f.name] = String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => (/^-?\d+$/.test(s) ? Number(s) : s));
    else if (['INTEGER', 'LONG', 'FLOAT'].includes(f.type)) out[f.name] = Number(raw);
    else if (f.type === 'BOOLEAN') out[f.name] = /^(true|1|yes)$/i.test(String(raw));
    else out[f.name] = raw;
  }
  return out;
}

/* ----------------------------------------------------------------- requests */
function viewRequests() {
  const r = state.report;
  const stats = r?.requests?.stats;
  const rate = r?.requests?.rate;
  const data = state.requests || { entries: r?.requests?.recent || [], stats };
  const cur = r?.dashboard?.currency;
  return `
    <div class="grid kpis" style="margin-bottom:14px">
      ${kpi('Requests logged', fmt.num(stats?.total || 0), `${fmt.num(stats?.retries || 0)} retried`, null)}
      ${kpi('Error rate', fmt.pct(stats?.errorRatePct || 0), Object.entries(stats?.byCode || {}).map(([c, n]) => `${c}×${n}`).join(' · ') || 'no errors', null, (stats?.errorRatePct || 0) > 5 ? 'bad' : 'good')}
      ${kpi('Latency p50 / p95', `${fmt.num(stats?.p50 || 0)} / ${fmt.num(stats?.p95 || 0)} ms`, `max ${fmt.num(stats?.max || 0)} ms`, null)}
      ${kpi('Rate limiter', `${fmt.num(rate?.tokens ?? 0, 1)} / ${fmt.num(rate?.refillPerSec ?? 0)} tok`, `${fmt.num(rate?.denied || 0)} local defers · peak ${fmt.num(rate?.peakPerSec || 0)}/s · avg wait ${fmt.num(stats?.avgWaitMs || 0)} ms`, null, (rate?.denied || 0) > 0 ? 'warnv' : '')}
    </div>
    <div class="card">
      <div class="card-head">
        <div><h3>Signed request log</h3><p class="hint">Every call this dashboard made, with its gateway verdict. Bodies contain no secrets — <code class="mono">app_secret</code> is only ever used to compute the sign.</p></div>
        <div class="row">
          <button class="btn small" data-act="requests-refresh">Reload</button>
          <button class="btn small" data-act="requests-clear">Clear</button>
        </div>
      </div>
      <div class="table-wrap" style="max-height:620px">
        <table>
          <thead><tr><th>#</th><th>Type</th><th>Result</th><th class="right">Latency</th><th class="right">Wait</th><th>Request id</th><th></th></tr></thead>
          <tbody>
            ${(data.entries || []).map((e) => `
              <tr>
                <td class="dim mono">${e.id}</td>
                <td class="mono">${esc(e.type)}</td>
                <td><span class="status-code ${e.ok ? 'ok' : 'err'}">${e.errorCode ?? '—'}${e.ok ? ' ✓' : ' ✗'}</span>
                  ${e.error ? `<div class="dim" style="font-size:11px">${esc(e.decoded?.meaning || String(e.error).slice(0, 60))}</div>` : ''}</td>
                <td class="right mono">${fmt.num(e.latencyMs)} ms</td>
                <td class="right mono dim">${fmt.num(e.waitMs || 0)} ms</td>
                <td class="mono dim">${esc(e.requestId || '—')}</td>
                <td><button class="btn small ghost" data-act="copy" data-copy="${esc(e.curl || '')}">curl</button>
                    <button class="btn small ghost" data-act="copy" data-copy="${esc(JSON.stringify(e.body, null, 1))}">body</button></td>
              </tr>`).join('') || '<tr><td colspan="7" class="empty">No requests yet — refresh the data or fire something from the API explorer.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ----------------------------------------------------------------- webhooks */
function viewWebhooks() {
  const r = state.report;
  const inbox = state.inbox || r?.webhooks || [];
  const origin = location.origin;
  const sample = state.webhookSample;
  return `
    <div class="banner">🪝 <div>Webhook receiver lives at <code>${esc(origin)}/webhook/temu</code>. It verifies <b>HMAC-SHA256</b> over the sorted <code class="mono">x-tm-*</code> params + <code class="mono">eventData</code> with your <code class="mono">app_secret</code> before storing anything — <code class="mono">401</code> on mismatch.</div></div>
    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><div><h3>Send yourself a signed test event</h3><p class="hint">Generates a correctly-signed callback so you can test your own verification code end to end.</p></div></div>
        <label class="field"><span>Event code</span>
          <select id="wh-event">
            ${['bg_order_status_change_event', 'bg_aftersales_status_change', 'bg_cancel_order_status_change', 'bg_trade_logistics_address_changed', 'bg_open_event_test'].map((e) => `<option>${e}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>eventData (JSON)</span>
          <textarea id="wh-data" rows="4">${esc(JSON.stringify({ orderSn: 'PO-211-21000000000000001', status: 1 }, null, 1))}</textarea>
        </label>
        <button class="btn primary" data-act="wh-sample">Sign &amp; store sample</button>
        ${sample ? `
          <p class="hint" style="margin-top:12px">POST this to your endpoint to test it:</p>
          <pre class="code">${esc(`${curlWebhook(origin, sample)}`)}</pre>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Verification rules</h3><p class="hint">Straight from the documented webhook spec.</p></div></div>
        <ol class="hint" style="padding-left:18px;line-height:1.9">
          <li>Collect header params <code class="mono">x-tm-app-key</code>, <code class="mono">x-tm-event-code</code>, <code class="mono">x-tm-timestamp</code>, <code class="mono">x-tm-ext-param</code> plus body <code class="mono">eventData</code>.</li>
          <li>Sort by name ascending, join as <code class="mono">key=value&amp;…</code>.</li>
          <li>HMAC-SHA256 with <code class="mono">app_secret</code>, HEX-encode, compare to <code class="mono">x-tm-signature</code>.</li>
          <li>Only then act on the event (and re-check the timestamp window).</li>
        </ol>
        <details class="help" open><summary>Endpoint URL for the Partner Platform app settings</summary>
          <div class="mono" style="margin-top:6px">${esc(origin)}/webhook/temu</div>
          <div class="hint" style="margin-top:6px">Must be HTTPS and go through the approval process on the Partner Platform. Tunnel your local server (e.g. a reverse proxy) while developing.</div>
        </details>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <div><h3>Inbox</h3><p class="hint">${inbox.length} event(s), newest first. Signature verdict is computed on arrival.</p></div>
        <button class="btn small" data-act="wh-clear">Clear inbox</button>
      </div>
      <div class="table-wrap" style="max-height:520px">
        <table>
          <thead><tr><th>When</th><th>Event</th><th>Signature</th><th>Payload</th><th></th></tr></thead>
          <tbody>
            ${inbox.map((w) => `
              <tr>
                <td class="dim mono">${new Date(w.at).toISOString().slice(11, 19)}</td>
                <td class="mono">${esc(w.eventCode || '—')}</td>
                <td><span class="status-code ${w.verified ? 'ok' : 'err'}">${w.verified ? 'verified' : 'REJECTED'}</span>${w.reason ? `<div class="dim" style="font-size:11px">${esc(w.reason)}</div>` : ''}</td>
                <td class="mono wrap" style="max-width:420px">${esc((w.decoded ? JSON.stringify(w.decoded) : w.eventData || '').slice(0, 160))}</td>
                <td><button class="btn small ghost" data-act="copy" data-copy="${esc(JSON.stringify(w, null, 1))}">copy</button></td>
              </tr>`).join('') || '<tr><td colspan="5" class="empty">Inbox empty. Send yourself a sample event above, or point a Temu subscription at this URL.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

const curlWebhook = (origin, s) =>
  `curl -X POST '${origin}/webhook/temu' \\\n  -H 'content-type: application/json' \\\n  -H 'x-tm-app-key: ${s.headers['x-tm-app-key']}' \\\n  -H 'x-tm-event-code: ${s.headers['x-tm-event-code']}' \\\n  -H 'x-tm-timestamp: ${s.headers['x-tm-timestamp']}' \\\n  -H 'x-tm-signature: ${s.signature}' \\\n  -d '${JSON.stringify({ eventData: s.eventData })}'`;

/* ------------------------------------------------------------------- import */
function viewImport() {
  const r = state.report;
  const csv = r?.dashboard?.csv || state.csvSummary;
  const ds = state.boot?.csv;
  return `
    <div class="banner warn">📄 <div><b>Why CSV exists here:</b> affiliate.temu.com has no public reporting API for affiliates — only the seller/ERP Partner Platform is documented. So real affiliate numbers arrive either from an export file or from an affiliate network you can query. This importer auto-detects columns, so most network exports drop straight in.</div></div>
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><div><h3>Import a CSV / TSV export</h3><p class="hint">Paste the file, or pick it from disk. Nothing is uploaded anywhere — the file never leaves this process.</p></div></div>
        <div class="row" style="margin-bottom:9px">
          <input type="file" id="csv-file" accept=".csv,.txt,.tsv" class="btn" style="padding:6px"/>
          <span class="hint">Detected columns: date, clicks, orders, gmv/sales, commission, spend, country, sub_id, product…</span>
        </div>
        <textarea id="csv-text" rows="9" placeholder="date,clicks,orders,sales,commission,country&#10;2026-10-01,1840,52,3120.55,312.06,US"></textarea>
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-act="csv-import">Import</button>
          <button class="btn" data-act="csv-sample">Insert sample export</button>
          <label class="row" style="gap:6px"><input type="checkbox" id="csv-activate" checked style="width:auto"/> <span class="hint">switch adapter to “csv”</span></label>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Imported data</h3><p class="hint">${ds ? `${ds.rows} rows · ${ds.currency} · imported ${new Date(ds.importedAt).toLocaleString()}` : 'Nothing imported yet.'}</p></div></div>
        ${csv ? `
          <div class="grid" style="grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px">
            ${kpi('Commission', fmt.money(csv.totals.commission, csv.currency), `rate ${fmt.pct(csv.derived.commissionRate)}`, null)}
            ${kpi('Sales', fmt.money(csv.totals.gmv, csv.currency), `AOV ${fmt.money(csv.derived.aov, csv.currency)}`, null)}
            ${kpi('Clicks / CTR', `${fmt.num(csv.totals.clicks)} / ${fmt.pct(csv.derived.ctr, 2)}`, `CVR ${fmt.pct(csv.derived.cvr, 2)}`, null)}
            ${kpi('EPC', fmt.money(csv.derived.epc, csv.currency, 3), `spend ${fmt.money(csv.totals.spend, csv.currency)}`, null)}
          </div>
          <div class="table-wrap" style="max-height:230px">
            <table><thead><tr><th>Key</th><th class="right">Clicks</th><th class="right">Orders</th><th class="right">Sales</th><th class="right">Commission</th></tr></thead>
            <tbody>${(csv.breakdown || []).map((b) => `<tr><td>${esc(b.key)}</td><td class="right mono">${fmt.num(b.clicks)}</td><td class="right mono">${fmt.num(b.orders)}</td><td class="right mono">${fmt.money(b.gmv, csv.currency, 2)}</td><td class="right mono">${fmt.money(b.commission, csv.currency, 2)}</td></tr>`).join('')}</tbody></table>
          </div>
          ${ds?.unmapped?.length ? `<p class="hint" style="margin-top:9px">Unmapped columns ignored: <span class="mono">${esc(ds.unmapped.join(', '))}</span></p>` : ''}
        ` : '<p class="hint">Import a file to see totals, per-day series and a channel breakdown. With the “csv” adapter selected, the Overview tab renders these numbers instead of API calls.</p>'}
      </div>
    </div>`;
}

/* ----------------------------------------------------------------- settings */
function viewSettings() {
  const s = state.settings;
  const boot = state.boot;
  const alerts = s.alerts || {};
  return `
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><div><h3>Data source</h3><p class="hint">Mock works offline with zero credentials; partner hits the real API.</p></div></div>
        <label class="field"><span>Adapter</span>
          <select id="s-adapter">${(boot?.adapters || []).map((a) => `<option value="${a.id}" ${s.adapter === a.id ? 'selected' : ''}>${esc(a.id)} — ${esc(a.label)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Region host</span>
          <select id="s-region">${(boot?.regions || []).map((r) => `<option value="${r.id}" ${s.region === r.id ? 'selected' : ''}>${esc(r.id)} — ${esc(r.label)} (${esc(r.host.replace('https://', ''))})</option>`).join('')}</select>
        </label>
        <div class="split">
          <label class="field"><span>Requests per second (quota)</span><input id="s-qps" type="number" min="1" max="100" value="${esc(s.qps)}"/><small>Documented default: 20 QPS per app_key.</small></label>
          <label class="field"><span>Amount lookups per build</span><input id="s-lookups" type="number" min="0" max="200" value="${esc(s.amountLookups || 45)}"/><small>One API call each — costs quota.</small></label>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Credentials</h3><p class="hint">Held in memory. Never written to disk unless you set <code class="mono">ALLOW_SECRET_PERSIST=1</code>.</p></div></div>
        <label class="field"><span>app_key</span><input id="s-appkey" type="text" value="${esc(s.appKey || '')}" placeholder="from the Partner Platform app"/></label>
        <label class="field"><span>app_secret</span><input id="s-appsecret" type="password" value="" placeholder="${s.appSecret ? '•••••••• (stored in memory)' : 'used only to compute sign'}"/><small>Leave blank to keep the current value.</small></label>
        <label class="field"><span>access_token</span><input id="s-token" type="password" value="" placeholder="${s.accessToken ? esc(s.accessToken) : 'seller-authorised token'}"/></label>
        <label class="field"><span>mallId (optional)</span><input id="s-mall" type="text" value="${esc(s.mallId || '')}"/></label>
        <div class="row">
          <button class="btn primary" data-act="settings-save">Save</button>
          <button class="btn" data-act="settings-reset">Reset to env defaults</button>
        </div>
        <details class="help" open><summary>Environment equivalent</summary>
          <pre class="code" style="margin-top:8px">TEMU_ADAPTER=${esc(s.adapter)}
TEMU_REGION=${esc(s.region)}
TEMU_APP_KEY=${esc(s.appKey || '<app_key>')}
TEMU_APP_SECRET=<app_secret>
TEMU_ACCESS_TOKEN=<access_token>
TEMU_QPS=${esc(s.qps)}
ALLOW_SECRET_PERSIST=0   # keep 0 unless you want secrets on disk</pre>
        </details>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <div class="card-head"><div><h3>Alert thresholds</h3><p class="hint">Tune what the rules engine considers a problem.</p></div></div>
        <div class="split">
          <label class="field"><span>Token expiry warning (hours)</span><input id="s-tokenh" type="number" value="${esc(alerts.tokenExpiryHours)}"/></label>
          <label class="field"><span>Error-rate ceiling (%)</span><input id="s-errrate" type="number" value="${esc(alerts.errorRatePct)}"/></label>
          <label class="field"><span>Minimum ROAS (×)</span><input id="s-roas" type="number" step="0.1" value="${esc(alerts.minRoas)}"/></label>
          <label class="field"><span>Maximum ACOS (%)</span><input id="s-acos" type="number" value="${esc(alerts.maxAcos)}"/></label>
          <label class="field"><span>Unshipped aging (hours)</span><input id="s-aging" type="number" value="${esc(alerts.unshippedAgeHours)}"/></label>
          <label class="field"><span>Refund-rate ceiling (%)</span><input id="s-refund" type="number" value="${esc(alerts.refundRatePct)}"/></label>
        </div>
        <label class="field"><span>Assumed commission rate (%) — projection only</span><input id="s-commission" type="number" step="0.5" value="${esc(s.assumedCommissionRate)}"/><small>Used only when no CSV is imported: settlement × rate. It is labelled a projection everywhere.</small></label>
        <button class="btn primary" data-act="settings-thresholds">Save thresholds</button>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Security &amp; deployment</h3><p class="hint">What this tool does with your keys.</p></div></div>
        <ul class="hint" style="padding-left:18px;line-height:1.9">
          <li>Secrets stay in process memory; the API never returns them (only masked previews).</li>
          <li><code class="mono">app_secret</code> is used solely to compute <code class="mono">sign</code> and never appears in request bodies or the request log.</li>
          <li>Mutating endpoints require the <code class="mono">x-dashboard: 1</code> header, so a random page in your browser cannot blind-POST to it.</li>
          <li>The default bind is <code class="mono">0.0.0.0</code> so sandbox previews work. On a shared network set <code class="mono">HOST=127.0.0.1</code>, and never expose it publicly with live credentials loaded.</li>
          <li>No telemetry, no external calls except the Temu host you select.</li>
        </ul>
        <div class="row" style="margin-top:10px">
          <button class="btn" data-act="copy" data-copy="${esc(JSON.stringify({ ...state.report?.dashboard?.kpis, currency: state.report?.dashboard?.currency }, null, 1))}">Copy KPI snapshot</button>
          <button class="btn" data-act="copy" data-copy="${esc(JSON.stringify(state.report?.alerts || [], null, 1))}">Copy alerts</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><div><h3>Gateway error reference</h3><p class="hint">The common error codes, decoded — handy when a call fails at 3am.</p></div></div>
      <div class="table-wrap" style="max-height:340px">
        <table><thead><tr><th>Code</th><th>Message</th><th>What it means</th><th>What to do</th></tr></thead>
        <tbody>${Object.entries(boot?.gatewayErrors || {}).map(([code, e]) => `
          <tr><td class="mono">${esc(code)}</td><td class="mono wrap">${esc(e.msg)}</td><td class="wrap">${esc(e.meaning)}</td><td class="wrap">${esc(e.hint)}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ events */
document.addEventListener('click', async (ev) => {
  const target = ev.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;

  if (act === 'close-modal' && ev.target.closest('[data-stop]') && ev.target === target) return;
  if (ev.target.closest('[data-stop]') && act !== 'copy' && act !== 'explore-type' && act !== 'close-modal') return;

  switch (act) {
    case 'tab':
      state.tab = target.dataset.tab;
      render();
      break;
    case 'refresh':
      await refreshWithProgress();
      break;
    case 'copy':
      copy(target.dataset.copy || '', 'Copied to clipboard');
      break;
    case 'open-order':
      state.openOrder = target.dataset.sn;
      render();
      break;
    case 'close-modal':
      state.openOrder = null;
      state.modal = null;
      render();
      break;
    case 'explore-type': {
      state.openOrder = null;
      state.tab = 'explorer';
      state.ep.selected = target.dataset.type;
      state.ep.params = { [target.dataset.param]: target.dataset.value };
      state.ep.view = 'request';
      state.ep.result = null;
      state.ep.preview = null;
      render();
      break;
    }
    case 'ep-cat':
      state.ep.cat = target.dataset.cat;
      state.ep.selected = null;
      render();
      break;
    case 'ep-select':
      state.ep.selected = target.dataset.name;
      state.ep.result = null;
      state.ep.preview = null;
      state.ep.params = {};
      render();
      break;
    case 'ep-view':
      state.ep.view = target.dataset.view;
      render();
      break;
    case 'ep-preview':
      await epPreview();
      break;
    case 'ep-send':
      await epSend();
      break;
    case 'requests-refresh':
      state.requests = await api('/api/requests?limit=50', { header: false });
      render();
      break;
    case 'requests-clear':
      await api('/api/requests/clear', { method: 'POST' });
      state.requests = { entries: [], stats: { total: 0, byCode: {} } };
      toast('Request log cleared', 'ok');
      render();
      break;
    case 'wh-sample': {
      const eventCode = $('#wh-event')?.value;
      let eventData;
      try { eventData = JSON.parse($('#wh-data')?.value || '{}'); } catch { toast('eventData must be valid JSON', 'err'); break; }
      state.webhookSample = await api('/api/webhook/sample', { method: 'POST', body: { eventCode, eventData } });
      state.inbox = (await api('/api/webhooks', { header: false })).inbox;
      toast('Sample event signed and stored', 'ok');
      render();
      break;
    }
    case 'wh-clear':
      await api('/api/webhooks/clear', { method: 'POST' });
      state.inbox = [];
      render();
      break;
    case 'csv-sample': {
      const text = sampleCsv();
      $('#csv-text').value = text;
      toast('Sample export inserted — click Import', 'ok');
      break;
    }
    case 'csv-import': {
      const text = $('#csv-text')?.value || '';
      if (!text.trim()) { toast('Nothing to import', 'err'); break; }
      try {
        const out = await api('/api/csv/import', { method: 'POST', body: { text, source: 'pasted' } });
        state.csvSummary = out.summary;
        if ($('#csv-activate')?.checked) {
          await api('/api/settings', { method: 'POST', body: { adapter: 'csv' } });
          state.settings = (await api('/api/state', { header: false })).settings;
          state.boot = await api('/api/state', { header: false });
          state.tab = 'import';
          await loadReport({ force: true });
        } else {
          toast(`Imported ${out.imported.rows} rows`, 'ok');
        }
        render();
      } catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'settings-save': {
      const patch = {
        adapter: $('#s-adapter').value,
        region: $('#s-region').value,
        qps: Number($('#s-qps').value),
        amountLookups: Number($('#s-lookups').value),
        appKey: $('#s-appkey').value.trim(),
        mallId: $('#s-mall').value.trim(),
      };
      const secret = $('#s-appsecret').value;
      const token = $('#s-token').value;
      if (secret) patch.appSecret = secret;
      if (token) patch.accessToken = token;
      const out = await api('/api/settings', { method: 'POST', body: patch });
      state.settings = { ...out.settings, amountLookups: patch.amountLookups };
      state.boot = await api('/api/state', { header: false });
      toast('Settings saved', 'ok');
      await loadReport({ force: true });
      break;
    }
    case 'settings-thresholds': {
      const alerts = {
        tokenExpiryHours: Number($('#s-tokenh').value),
        errorRatePct: Number($('#s-errrate').value),
        minRoas: Number($('#s-roas').value),
        maxAcos: Number($('#s-acos').value),
        unshippedAgeHours: Number($('#s-aging').value),
        refundRatePct: Number($('#s-refund').value),
      };
      const out = await api('/api/settings', { method: 'POST', body: { alerts, assumedCommissionRate: Number($('#s-commission').value) } });
      state.settings = out.settings;
      toast('Thresholds saved', 'ok');
      render();
      break;
    }
    case 'settings-reset':
      state.settings = (await api('/api/settings/reset', { method: 'POST' })).settings;
      state.boot = await api('/api/state', { header: false });
      toast('Settings reset', 'ok');
      await loadReport({ force: true });
      break;
    default:
      break;
  }
});

document.addEventListener('input', async (ev) => {
  const el = ev.target;
  if (el.id === 'ep-q') {
    state.ep.q = el.value;
    const list = $('.ep-list');
    if (list) {
      const cat = state.catalog;
      const filtered = cat.endpoints.filter((e) =>
        (state.ep.cat === 'all' || e.category === state.ep.cat) &&
        (!state.ep.q || e.name.toLowerCase().includes(state.ep.q.toLowerCase())));
      list.innerHTML = filtered.slice(0, 200).map((e) => `<button class="ep-item ${state.ep.selected === e.name ? 'active' : ''}" data-act="ep-select" data-name="${esc(e.name)}">
        <div class="name">${esc(e.name)}</div><div class="cat">${esc(e.title || '')} · ${e.params.length} params</div></button>`).join('') || '<div class="empty">No endpoint matches.</div>';
    }
  }
  if (el.dataset?.act === 'ep-param') {
    state.ep.params[el.dataset.name] = el.value;
  }
  if (el.id === 'order-q') {
    state.orderFilter = { ...(state.orderFilter || { status: 'all' }), q: el.value };
    const pos = el.selectionStart;
    render();
    const next = $('#order-q');
    if (next) { next.focus(); next.setSelectionRange(pos, pos); }
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.id === 'order-status') {
    state.orderFilter = { ...(state.orderFilter || { q: '' }), status: el.value };
    render();
  }
  if (el.id === 'ep-simulate') state.ep.simulate = el.value;
  if (el.id === 'csv-file' && el.files?.[0]) {
    const text = await el.files[0].text();
    $('#csv-text').value = text;
    toast(`Loaded ${el.files[0].name} — click Import`, 'ok');
  }
});

/* ------------------------------------------------------------------ sample */
function sampleCsv() {
  const lines = ['date,sub_id,country,impressions,clicks,orders,sales,commission,spend'];
  const nets = ['pinterest', 'tiktok-bio', 'newsletter', 'youtube-desc'];
  const countries = ['US', 'CA', 'DE', 'GB'];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const clicks = Math.round(1200 + Math.random() * 900);
    const impressions = clicks * (60 + Math.round(Math.random() * 40));
    const orders = Math.max(1, Math.round(clicks * (0.02 + Math.random() * 0.02)));
    const sales = Math.round(orders * (38 + Math.random() * 30) * 100) / 100;
    const commission = Math.round(sales * 0.11 * 100) / 100;
    const spend = Math.round(clicks * 0.28 * 100) / 100;
    lines.push([d, nets[i % nets.length], countries[i % countries.length], impressions, clicks, orders, sales, commission, spend].join(','));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------- start */
boot();
window.addEventListener('resize', () => {
  if (state.tab === 'overview') drawCharts();
  if (state.tab === 'ads') drawAdsCharts();
});
