/**
 * ui.test.js — renders the real front-end against the real API.
 *
 * There is no browser here, so this installs a minimal DOM shim, points fetch at
 * a live server on an ephemeral port, imports public/app.js (which boots and
 * renders) and then drives every tab the way a click would. If a view throws, or
 * silently renders an empty panel, this test fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'temu-dash-ui-'));
process.env.REPORT_CACHE_MS = '0';

/* ------------------------------------------------------------------ DOM shim */
function makeElement(id = '') {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    files: null,
    classList: { add() {}, remove() {}, contains: () => false },
    children: [],
    append(child) { this.children.push(child); },
    remove() {},
    focus() {},
    setSelectionRange() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener() {},
  };
  return el;
}

const elements = new Map();
const toasts = [];
const handlers = {};

globalThis.document = {
  querySelector(sel) {
    if (sel === '#toasts') {
      return {
        ...makeElement('toasts'),
        append(el) { toasts.push(el); },
      };
    }
    if (!elements.has(sel)) elements.set(sel, makeElement(sel));
    return elements.get(sel);
  },
  querySelectorAll: () => [],
  createElement: () => makeElement(),
  addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
  removeEventListener() {},
};
globalThis.window = { addEventListener() {}, location: { origin: 'http://dash.test' } };
globalThis.location = { origin: 'http://dash.test' };
// Node 22 exposes `navigator` as a getter-only global.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});
globalThis.EventSource = class { addEventListener() {} close() {} };

/* ------------------------------------------------------------- live backend */
const { createDashboardServer } = await import('../server/index.js');
const server = createDashboardServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).startsWith('http') ? url : base + url, init);

test.after(() => server.close());

/* --------------------------------------------------------------- the checks */
const click = async (dataset) => {
  const target = {
    dataset,
    value: undefined,
    files: null,
    id: '',
    // behave like a real element: only the selector it actually matches resolves
    closest: (sel) => (sel === '[data-act]' ? target : null),
  };
  for (const fn of handlers.click || []) await fn({ target, preventDefault() {} });
};

const main = () => elements.get('#main')?.innerHTML || '';
const top = () => elements.get('#top')?.innerHTML || '';
const errorToasts = () => toasts.filter((t) => t.className?.includes('err')).map((t) => t.textContent);

await import('../public/app.js');

test('boot renders the overview without a browser', async () => {
  for (let i = 0; i < 60 && !main().includes('Money per day'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(top().includes('Temu Partner API'), 'header rendered');
  assert.ok(top().includes('mock adapter'), 'adapter pill rendered');
  assert.match(main(), /Money per day/);
  assert.match(main(), /GMV \(priced orders\)/);
  assert.match(main(), /Commission projection/);
  assert.match(main(), /Revenue by market/);
  assert.match(main(), /Token &amp; authorisation|Token &/)
  assert.deepEqual(errorToasts(), [], 'no view leaked an error toast');

  // charts were injected as SVG into the slots
  assert.match(elements.get('#chart-money-slot').innerHTML, /<svg/, 'money chart drawn');
  assert.match(elements.get('#chart-roas-slot').innerHTML, /ROAS/, 'roas legend drawn');
  assert.ok(main().includes('data:') === false);
});

test('every tab renders its own content', async () => {
  const expectations = {
    orders: [/parent orders/, /Parent order/, /temu\.order\.amount\.v2\.query/],
    ads: [/Ad spend/, /Performance by goods/, /Funnel|Impressions/],
    explorer: [/endpoints/, /bg\.order\.list\.v2\.get|bg\.order\.list/, /quota/],
    requests: [/Signed request log/, /Rate limiter/],
    webhooks: [/webhook\/temu/, /HMAC-SHA256/, /Inbox/],
    import: [/Import a CSV/, /affiliate exports have no public API|no public reporting API/],
    settings: [/Data source/, /Credentials/, /Gateway error reference/, /ALLOW_SECRET_PERSIST/],
    overview: [/Money per day/],
  };
  for (const [tab, patterns] of Object.entries(expectations)) {
    await click({ act: 'tab', tab });
    const html = main();
    for (const re of patterns) {
      assert.match(html, re, `tab "${tab}" should render ${re}`);
    }
  }
  assert.deepEqual(errorToasts(), [], 'no tab threw');
});

test('no tab leaks undefined, NaN or [object Object] into the markup', async () => {
  for (const tab of ['overview', 'orders', 'ads', 'explorer', 'requests', 'webhooks', 'import', 'settings']) {
    await click({ act: 'tab', tab });
    const html = main();
    assert.ok(!/>\s*undefined\s*</.test(html), `${tab}: rendered "undefined"`);
    assert.ok(!html.includes('[object Object]'), `${tab}: rendered "[object Object]"`);
    assert.ok(!/\bNaN\b/.test(html), `${tab}: rendered "NaN"`);
    assert.ok(!/\$NaN|NaN%|NaN×/.test(html), `${tab}: rendered a NaN metric`);
  }
});

test('the ads tab draws its chart too', async () => {
  await click({ act: 'tab', tab: 'ads' });
  assert.match(elements.get('#ads-daily-slot').innerHTML, /<svg/);
});

test('the explorer renders a selected endpoint with its parameters', async () => {
  await click({ act: 'tab', tab: 'explorer' });
  await click({ act: 'ep-select', name: 'bg.order.detail.v2.get' });
  const html = main();
  assert.match(html, /bg\.order\.detail\.v2\.get/);
  assert.match(html, /parentOrderSn/, 'endpoint parameters are rendered as inputs');
  assert.match(html, /Preview signed request/);
  assert.match(html, /no error simulation/);
});

test('orders tab survives the empty and populated filter states', async () => {
  await click({ act: 'tab', tab: 'orders' });
  assert.match(main(), /Search order SN or goods/);
  assert.match(main(), /PO-\d+-\d+/, 'order rows rendered');
});

test('an order detail modal opens with its settlement breakdown', async () => {
  await click({ act: 'tab', tab: 'orders' });
  // open the most recent order exactly as a row click would
  const sn = main().match(/data-sn="([^"]+)"/)?.[1];
  assert.ok(sn, 'found an order row');
  await click({ act: 'open-order', sn });
  const html = main();
  assert.match(html, /Customer paid/);
  assert.match(html, /Settlement/);
  assert.match(html, /Copy order JSON/);
  await click({ act: 'close-modal' });
  assert.ok(!main().includes('Copy order JSON'), 'modal closed again');
});
