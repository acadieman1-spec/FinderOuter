/**
 * config.js — runtime configuration for the dashboard.
 *
 * Credentials resolve in this order: dashboard settings (POST /api/settings,
 * held in memory) -> environment variables (.env style). Nothing is written to
 * disk unless ALLOW_SECRET_PERSIST=1.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');

export const REGIONS = {
  US: { host: 'https://openapi-b-us.temu.com/openapi/router', label: 'United States', currency: 'USD' },
  EU: { host: 'https://openapi-b-eu.temu.com/openapi/router', label: 'Europe (DE/IT/FR/ES/UK…)', currency: 'EUR' },
  GLOBAL: { host: 'https://openapi-b-global.temu.com/openapi/router', label: 'Global (MX/JP…)', currency: 'MXN' },
};

export const ADAPTERS = {
  mock: 'Synthetic fixtures shaped like real Partner API responses (no credentials, no network)',
  partner: 'Live Temu Partner API calls (app_key + app_secret + access_token)',
  csv: 'Affiliate/partner CSV export import (affiliate.temu.com has no public API)',
};

/** Load a minimal KEY=VALUE .env if present (does not overwrite real env vars). */
function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

export const DEFAULT_SETTINGS = {
  adapter: (process.env.TEMU_ADAPTER || 'mock').toLowerCase(),
  region: (process.env.TEMU_REGION || 'US').toUpperCase(),
  appKey: process.env.TEMU_APP_KEY || '',
  appSecret: process.env.TEMU_APP_SECRET || '',
  accessToken: process.env.TEMU_ACCESS_TOKEN || '',
  mallId: process.env.TEMU_MALL_ID || '',
  qps: Number(process.env.TEMU_QPS || 20),
  currency: process.env.TEMU_CURRENCY || '',
  timezone: process.env.TEMU_TZ || 'UTC',
  // Projection only: the Partner API exposes settlement, not affiliate commission.
  assumedCommissionRate: Number(process.env.TEMU_COMMISSION_RATE || 10),
  maxRetries: Number(process.env.TEMU_MAX_RETRIES || 3),
  // report window (sticky, so a reload hits the cache instead of the quota)
  days: Number(process.env.TEMU_DAYS || 30),
  amountLookups: Number(process.env.TEMU_AMOUNT_LOOKUPS || 45),
  adsDays: Number(process.env.TEMU_ADS_DAYS || 14),
  requestTimeoutMs: Number(process.env.TEMU_TIMEOUT_MS || 15_000),
  alerts: {
    tokenExpiryHours: 72,
    errorRatePct: 5,
    minRoas: 2,
    maxAcos: 45,
    unshippedAgeHours: 48,
    refundRatePct: 8,
  },
};

export const ALLOW_SECRET_PERSIST = process.env.ALLOW_SECRET_PERSIST === '1';
export const PORT = Number(process.env.PORT || 4173);
export const HOST = process.env.HOST || '0.0.0.0';
