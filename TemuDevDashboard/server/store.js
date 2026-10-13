/**
 * store.js — in-memory settings + optional non-secret persistence.
 *
 * Secrets live in memory only. They are written to data/settings.json *only*
 * when ALLOW_SECRET_PERSIST=1, because a self-hosted dashboard should not
 * scatter app_secrets across the filesystem by accident.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, DEFAULT_SETTINGS, ALLOW_SECRET_PERSIST } from './config.js';

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const ALERTS_FILE = join(DATA_DIR, 'alert-history.json');
const WEBHOOK_FILE = join(DATA_DIR, 'webhook-inbox.json');

const SECRET_KEYS = ['appSecret', 'accessToken', 'appKey'];

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] || {}, v) : v;
  }
  return out;
}

class Store {
  constructor() {
    this.settings = { ...deepMerge(DEFAULT_SETTINGS, {}), ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts } };
    this.sessions = new Map(); // per-request overrides (e.g. playground "test with other creds")
    this.alertHistory = [];
    this.webhookInbox = [];
    this.csvDataset = null;
    this.load();
  }

  load() {
    try {
      if (existsSync(SETTINGS_FILE)) this.settings = deepMerge(this.settings, JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
      if (existsSync(ALERTS_FILE)) this.alertHistory = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
      if (existsSync(WEBHOOK_FILE)) this.webhookInbox = JSON.parse(readFileSync(WEBHOOK_FILE, 'utf8'));
    } catch { /* corrupt state should never block startup */ }
  }

  persist() {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const snapshot = JSON.parse(JSON.stringify(this.settings));
      if (!ALLOW_SECRET_PERSIST) for (const k of SECRET_KEYS) delete snapshot[k];
      writeFileSync(SETTINGS_FILE, JSON.stringify(snapshot, null, 2));
      writeFileSync(ALERTS_FILE, JSON.stringify(this.alertHistory.slice(-500), null, 2));
      writeFileSync(WEBHOOK_FILE, JSON.stringify(this.webhookInbox.slice(-200), null, 2));
    } catch { /* read-only filesystems are fine */ }
  }

  update(patch) {
    this.settings = deepMerge(this.settings, patch);
    if (Number(this.settings.qps) > 0) this.settings.qps = Number(this.settings.qps);
    if (Number(this.settings.assumedCommissionRate) >= 0) {
      this.settings.assumedCommissionRate = Number(this.settings.assumedCommissionRate);
    }
    this.persist();
    return this.settings;
  }

  /** Effective credentials for a request (request-scoped override wins). */
  credentials(sessionKey) {
    const override = sessionKey ? this.sessions.get(sessionKey) : null;
    const s = this.settings;
    return {
      adapter: override?.adapter || s.adapter,
      region: override?.region || s.region,
      appKey: override?.appKey || s.appKey,
      appSecret: override?.appSecret || s.appSecret,
      accessToken: override?.accessToken || s.accessToken,
      mallId: override?.mallId || s.mallId,
      qps: Number(s.qps) || 20,
      maxRetries: Number(s.maxRetries) || 3,
      requestTimeoutMs: Number(s.requestTimeoutMs) || 15_000,
      assumedCommissionRate: Number(s.assumedCommissionRate) || 0,
      currency: override?.currency || s.currency || '',
    };
  }

  /** Public view of settings: secrets masked, never raw. */
  publicSettings() {
    const s = this.settings;
    return {
      ...s,
      appSecret: s.appSecret ? '••••••••' : '',
      accessToken: s.accessToken ? `${s.accessToken.slice(0, 4)}…${s.accessToken.slice(-4)}` : '',
      appKey: s.appKey || '',
      secretsInMemory: Boolean(s.appSecret || s.accessToken),
      secretsPersisted: ALLOW_SECRET_PERSIST,
    };
  }

  recordAlert(alert) {
    this.alertHistory.unshift({ ...alert, at: Date.now() });
    this.alertHistory = this.alertHistory.slice(0, 500);
  }

  pushWebhook(entry) {
    this.webhookInbox.unshift(entry);
    this.webhookInbox = this.webhookInbox.slice(0, 200);
    this.persist();
  }

  setCsvDataset(dataset) {
    this.csvDataset = dataset;
  }

  reset() {
    this.settings = { ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts } };
    this.sessions.clear();
    this.alertHistory = [];
    this.webhookInbox = [];
    this.csvDataset = null;
    try {
      for (const f of [SETTINGS_FILE, ALERTS_FILE, WEBHOOK_FILE]) if (existsSync(f)) rmSync(f);
    } catch { /* ignore */ }
  }
}

export const store = new Store();
