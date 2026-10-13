# Temu Partner API — developer dashboard

A **free, self-hosted developer dashboard** for the [Temu Partner API](https://partner.temu.com/): request signing,
order and settlement metrics, ads reporting, rate-limit tracking, webhook verification and an interactive API explorer
covering all 138 documented endpoints.

No accounts, no sign-up, no metering, no telemetry, no paid tier. It runs on your machine, with your keys, and it
never talks to anything except the Temu host you select.

```bash
node server/index.js          # → http://localhost:4173
```

Zero runtime dependencies — `node:http`, `node:crypto` and built-in `fetch`. Node 18+.

---

## Read this first: what the Temu API actually gives you

This project is deliberately honest about the platform's limits, because most "Temu API dashboard" material isn't:

| You want | Reality |
|---|---|
| Seller/ERP data (orders, settlement, ads, catalogue, logistics) | ✅ Fully documented **Partner API**. This dashboard covers it end to end. |
| Affiliate commission / referral data | ❌ **affiliate.temu.com has no public reporting API.** The Partner Platform is for sellers and ISVs, not affiliates. |
| Affiliate numbers, in practice | Import the CSV export the affiliate portal gives you (**Import export** tab), or go through an affiliate network that has an API and map its fields onto this dashboard. |

So the dashboard gives you two honest money views and never blends them:

* **Settlement** — real, straight from `temu.order.amount.v2.query` (what Temu pays the seller after deductions).
* **Commission** — *imported* when you load a CSV export (real numbers), otherwise a clearly-labelled **projection**
  (`settlement × the rate you configure`). It is labelled a projection in the header, the KPI and the tooltip.

This is an independent tool. It is **not affiliated with, endorsed by, or connected to Temu or PDD Holdings**. All
endpoint names, parameter names and error codes referenced here are factual API reference data belonging to Temu; no
documentation prose is reproduced.

---

## Quick start

```bash
# 1. nothing to install — no dependencies
node server/index.js

# 2. open the preview / browser at http://localhost:4173
```

It boots on the **mock adapter**: synthetic orders, ads and goods, generated locally, pushed through the **real**
signing, envelope, rate-limit and error-code path. There is no network traffic and no credential needed, which makes
it a safe way to learn the API and to test your own tooling.

### Going live

```bash
cp .env.example .env
# then set:
#   TEMU_ADAPTER=partner
#   TEMU_REGION=US            # US | EU | GLOBAL
#   TEMU_APP_KEY=...
#   TEMU_APP_SECRET=...
#   TEMU_ACCESS_TOKEN=...     # from the seller authorisation flow (bg.open.accesstoken.create)
node server/index.js
```

You can also paste credentials into **Settings** in the UI; they are held in memory and never returned by the API
(masked previews only). Set `ALLOW_SECRET_PERSIST=1` only if you want them written to `data/settings.json`.

---

## What's in it

| Tab | What it does |
|---|---|
| **Overview** | GMV, settlement, deductions, AOV, refund/cancel rate, unshipped aging, ROAS/ACOS, traffic funnel, revenue by market, top goods, order pipeline, token & scope health, pipeline diagnostics. |
| **Orders** | Every fetched parent order with status, market, amounts, fulfilment warnings. Click a row for the `customerPaid` vs `salesProceeds` breakdown returned by `temu.order.amount.v2.query`. |
| **Ads & funnel** | Spend, ad-attributed GMV, ROAS/ACOS/CTR/CVR/CPC/CPM/EPC, impressions → clicks → carts → orders funnel, and a per-goods table that tells you what to pause. |
| **API explorer** | All **138 endpoints / 515 parameters** from the reference, as forms. Preview the exact signed body, the pre-sign string, the MD5 sign and a ready `curl` — then send it. Error simulation covers `3000001`, `3000032`, `3000034`, `4000004`, `4000000`, `5000003`. |
| **Request log** | Every call the dashboard made: gateway verdict, decoded error meaning, latency, limiter wait, retries, request id, copyable `curl`. |
| **Webhooks** | A receiver at `/webhook/temu` that verifies HMAC-SHA256 before trusting anything, an inbox with the verification verdict, and a signed sample-event sender so you can test your own verifier. |
| **Import export** | CSV/TSV affiliate or network export import with column auto-detection (date, clicks, orders, sales, commission, spend, country, sub_id, product…), totals, per-day series and channel breakdown. |
| **Settings** | Adapter, region host, credentials, QPS quota, amount-lookup budget, alert thresholds, projection rate, and the full gateway error reference with plain-language hints. |

### Alerts that fire on real failure modes

Token expiring (< 72h) or expired · missing API scopes for the panels you're looking at · gateway error-rate spike ·
rate limiting (local defers or real `4000004`s) · ROAS below floor · ACOS above ceiling · orders unshipped beyond the
aging threshold · refund rate above ceiling · and always, honestly, **amount coverage** when only part of the window is priced.

---

## How the signing works (and proof that it's right)

```
1. merge common params + business params
2. sort all top-level keys ascending    (nested object key order is preserved verbatim)
3. concatenate key+value with no separator
4. wrap with app_secret at the head and the tail
5. MD5 → upper-case hex
```

Temu's own documentation publishes a worked example with a known answer. The implementation here reproduces it
exactly, and the test suite asserts it, so the crypto layer is verified rather than assumed:

```
app_secret  c7e0a1a63542be4de3cb5488f9fba8149e8fc290
request     bg.logistics.shipment.confirm
expected    4CCF219942D4180C6DDA3CE36C1B838F
```

`test/sign.test.js` also proves that **nested key order changes the hash** (a subtle trap: re-sorting nested objects
silently breaks every request with a nested payload), that top-level insertion order does not matter, and that the
secret never appears in a request body.

The mock gateway verifies this signature on every call, so the demo you see is running the production code path.

**Webhooks** are verified with HMAC-SHA256 over the sorted `x-tm-app-key`, `x-tm-event-code`, `x-tm-timestamp`,
`x-tm-ext-param` and `eventData` parameters, joined as `key=value&…`, keyed by `app_secret`. Verification tolerates an
HTTP stack that drops an empty optional header (strict and normalised variants are both tried, and the matching
variant is reported).

---

## Metric definitions (no hand-waving)

| Metric | Where it comes from |
|---|---|
| GMV | `customerPaid.customerPaidTotal` per parent order |
| Settlement | `salesProceeds.estimatedSettlementTotal` |
| Deductions | `salesProceeds.estimatedDeduction` (falls back to GMV − settlement) |
| Units | order-line quantities (no amount lookup needed) |
| ROAS / ACOS | `orderPayAmt / spend` and `spend / orderPayAmt` from the mall ads report |
| CTR / CVR / CPC / CPM | `clkCnt / imprCnt`, `orderPayCnt / clkCnt`, `spend / clkCnt`, `spend / imprCnt × 1000` |
| Commission | **imported** (CSV) or **projected** at your configured rate — never presented as fact |

Two deliberate honesty features:

* **Amount coverage.** The order-list endpoint carries no money, so GMV/settlement come from one
  `temu.order.amount.v2.query` call **per parent order** — a real quota cost. The dashboard fetches the newest *N*
  (configurable) and states `priced/total` everywhere instead of extrapolating.
* **Mixed currencies.** A multi-market account trades in USD, EUR, GBP, CAD, MXN, JPY simultaneously. Totals are
  shown in the dominant currency, the mixing is flagged, and **FX conversion is deliberately not invented**.

---

## Dashboard API

Everything the UI does is available over HTTP (mutating routes need the `x-dashboard: 1` header):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Bootstrap: settings (masked), adapters, regions, catalogue summary, gateway errors |
| `GET` | `/api/catalog` | Full endpoint catalogue with parameters, error codes, response examples |
| `GET` | `/api/report` | The whole dashboard payload (cached, default 60s) |
| `GET` | `/api/report/stream` | Same, as Server-Sent Events with live progress |
| `POST` | `/api/report/refresh` | Force a rebuild; persists the window (`days`, `amountLookups`, `adsDays`) |
| `POST` | `/api/playground` | Build a signed request (`send:false`) or fire it (`send:true`) |
| `POST` | `/api/sign` | Return the pre-sign string + MD5 for any parameter set |
| `GET` | `/api/requests` | Request log with stats (p50/p95, error rate, retries, limiter waits) |
| `POST` | `/webhook/temu` | Inbound webhook receiver (HMAC-SHA256 verified, `401` on mismatch) |
| `POST` | `/api/webhook/sample` | Generate a correctly signed sample event |
| `POST` | `/api/csv/import` | Import an affiliate/network CSV export |
| `GET`/`POST` | `/api/settings`, `/api/settings/reset` | Configure the dashboard |

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TEMU_ADAPTER` | `mock` | `mock` \| `partner` \| `csv` |
| `TEMU_REGION` | `US` | `US` · `EU` · `GLOBAL` → selects the documented host |
| `TEMU_APP_KEY` / `TEMU_APP_SECRET` / `TEMU_ACCESS_TOKEN` | — | Partner Platform credentials |
| `TEMU_QPS` | `20` | Documented default quota per app_key |
| `TEMU_DAY`… `TEMU_AMOUNT_LOOKUPS` | `45` | How many orders get an amount lookup per build |
| `TEMU_ADS_DAYS` | `14` | One mall-report call per day |
| `TEMU_COMMISSION_RATE` | `10` | Projection rate, labelled as a projection |
| `REPORT_CACHE_MS` | `60000` | Cache TTL so browser refreshes don't burn quota |
| `ALLOW_SECRET_PERSIST` | `0` | `1` writes secrets to `data/settings.json` |
| `HOST` / `PORT` | `0.0.0.0` / `4173` | Use `HOST=127.0.0.1` on shared networks |

---

## Tests

```bash
npm test          # node --test test/*.test.js
```

42 tests, all passing, covering:

* the documented signature vector plus nested-key-order and secret-leak guards
* webhook HMAC round-trip, tampering, wrong secret, missing header
* the mock gateway rejecting a wrong signature (`3000001`) and clock skew (`3000012`)
* the full collect → normalise → metrics → alerts pipeline
* CSV import: quoting, thousands separators, column auto-detection, refusal of unusable files
* HTTP end-to-end: catalogue, report, caching, playground send, error simulation, webhook receive, settings masking
* a DOM-shim UI test that boots the real `public/app.js` against a live server and renders **every tab**, the charts, the explorer form and the order modal

## Project layout

```
server/
  index.js          HTTP server + routes + static hosting
  sign.js           MD5 request signing + HMAC webhook verification
  temuClient.js     signed, rate-limited, retrying client + request log
  normalize.js      one collection pipeline for mock and live transports
  metrics.js        KPI/timeseries computation
  alerts.js         the rules engine
  errorCodes.js     34 gateway error codes, decoded
  adapters/         mock.js · live.js · csv.js
public/             index.html · app.js · charts.js · styles.css · data/endpoints.json
scripts/            gen-endpoints.mjs — regenerate the catalogue from a docs snapshot
test/               sign · pipeline · api · ui
```

## Regenerating the endpoint catalogue

The catalogue ships generated (`public/data/endpoints.json`), so you never need this to run the app:

```bash
git clone --depth 1 https://github.com/opastorello/temu-api-docs.git /tmp/temu-docs
node scripts/gen-endpoints.mjs /tmp/temu-docs
```

## Security notes

* Secrets live in process memory; the API returns masked previews only.
* `app_secret` is used solely to compute `sign` and never appears in a request body or the request log.
* Mutating routes require `x-dashboard: 1`, so a random page in your browser cannot blind-POST to the dashboard.
* Default bind is `0.0.0.0` so sandbox/preview proxies work. On a shared network use `HOST=127.0.0.1`, and never
  expose it publicly with live credentials loaded.

## Limitations / roadmap

* Live mode is untested against a real Temu account (no credentials were available while building this); the mock
  gateway implements the documented contract faithfully, and everything except the network call is exercised in tests.
* Order-status labels (e.g. `1 → Pending shipment`) are inferred from public conventions and marked as inferred in the UI.
* Webhook `eventData` is documented as encrypted without publishing the algorithm, so the receiver verifies the
  signature over the payload it receives and additionally tries a base64→JSON decode for display.
* Rate limits are documented as *dynamically adjustable*; the limiter's 20 QPS default matches the docs and is configurable.

---

MIT, same licence as the repository this lives in.
