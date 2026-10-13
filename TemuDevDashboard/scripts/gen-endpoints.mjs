#!/usr/bin/env node
/**
 * gen-endpoints.mjs — build the API-explorer catalogue from a Temu Partner API
 * documentation snapshot (markdown mirror).
 *
 * The dashboard ships with a pre-generated catalogue at
 * `public/data/endpoints.json`, so you never need this script to run the app.
 * Use it only when you want to refresh the catalogue from a newer docs snapshot.
 *
 * Doc source (public mirror of the Temu Partner Platform docs):
 *   https://github.com/opastorello/temu-api-docs
 *
 *   git clone --depth 1 https://github.com/opastorello/temu-api-docs.git /tmp/temu-docs
 *   node scripts/gen-endpoints.mjs /tmp/temu-docs
 *
 * Endpoint names, parameter names and error codes are factual API reference
 * data belonging to Temu; they are reproduced here so the dashboard can show
 * developers the real request shapes. No documentation prose is copied.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'data', 'endpoints.json');

// Doc type codes -> readable types (per the docs' own type table).
const TYPE_MAP = { 1: 'INTEGER', 2: 'LONG', 3: 'FLOAT', 4: 'STRING', 5: 'BOOLEAN', 6: 'OBJECT', 8: 'ARRAY' };

const docsRoot = process.argv[2];
if (!docsRoot) {
  console.error('usage: node scripts/gen-endpoints.mjs <path-to-temu-api-docs-clone>');
  process.exit(2);
}
const apiRef = join(docsRoot, 'api-reference');
if (!existsSync(apiRef)) {
  console.error(`no api-reference directory under ${docsRoot}`);
  process.exit(2);
}

// "bg.order.list.v2.get" -> "Order list v2 get"
const titleFromName = (name) => {
  const parts = name.split('.').slice(1);
  if (!parts.length) return name;
  const words = parts.map((p, i) => (i === 0 ? p : p.toLowerCase())).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function parseTableRow(line) {
  const cells = line.split('|').map((c) => c.trim());
  // leading/trailing empty cells from the markdown pipes
  while (cells.length && cells[0] === '') cells.shift();
  while (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function parseDoc(file, category, name) {
  const md = readFileSync(file, 'utf8');
  const lines = md.split('\n');

  // Title line: "# bg.order.list.v2.get"
  const titleLine = lines.find((l) => l.startsWith('# ')) || '';
  const title = titleLine.replace(/^#\s+/, '').trim();

  // First prose paragraph after the title = short description.
  let description = '';
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('*') || l.startsWith('**Method') || l.startsWith('#') || l.startsWith('---')) {
      if (description) break;
      continue;
    }
    if (l.startsWith('|')) break;
    description = l.replace(/\*\*/g, '');
    break;
  }

  const sections = {};
  let current = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      current = h[1].trim();
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }

  const readTable = (heading, { skipHeader = 2, minCells = 3 } = {}) => {
    const body = sections[heading];
    if (!body) return [];
    const rows = body.filter((l) => l.trim().startsWith('|')).slice(skipHeader);
    return rows
      .map(parseTableRow)
      .filter((r) => r.length >= minCells && !/^-+$/.test(r[0] || ''));
  };

  const reqRows = readTable('Request Parameters');
  const params = reqRows.map((r) => ({
    name: r[0],
    type: TYPE_MAP[r[1]] || r[1] || 'ANY',
    required: /^y/i.test(r[2] || '') || r[2] === 'True',
    description: (r[3] || '').slice(0, 200),
  })).filter((p) => p.name && p.name !== '-');

  const errRows = readTable('Error Codes', { skipHeader: 2, minCells: 2 });
  const errors = errRows
    .map((r) => ({ code: Number(r[0]), message: r[1] || '' }))
    .filter((e) => Number.isFinite(e.code));

  // Request URL (region host) if the doc states one.
  const urlMatch = md.match(/https:\/\/openapi-b-[a-z]+\.temu\.com\/openapi\/router/);

  // A trimmed response example makes the explorer useful offline.
  const respMatch = md.match(/##\s*Response Example\s*```json\s*([\s\S]*?)```/);
  let responseExample = null;
  if (respMatch) {
    try {
      const parsed = JSON.parse(respMatch[1]);
      const text = JSON.stringify(parsed, null, 2);
      responseExample = text.length > 2000 ? text.slice(0, 2000) + '\n… (truncated)' : text;
    } catch {
      responseExample = null;
    }
  }

  return {
    name,
    title: title === name ? titleFromName(name) : title,
    responseExample,
    description,
    category,
    method: 'POST',
    url: urlMatch ? urlMatch[0] : 'https://openapi-b-global.temu.com/openapi/router',
    params,
    errors,
    docPath: file.replace(docsRoot + '/', ''),
  };
}

const endpoints = [];
for (const category of readdirSync(apiRef)) {
  const dir = join(apiRef, category);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const name = file.replace(/^\d+-/, '').replace(/\.md$/, '');
    try {
      endpoints.push(parseDoc(join(dir, file), category, name));
    } catch (err) {
      console.warn(`skip ${file}: ${err.message}`);
    }
  }
}

endpoints.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

const byCategory = {};
for (const e of endpoints) byCategory[e.category] = (byCategory[e.category] || 0) + 1;

const out = {
  generatedAt: new Date().toISOString(),
  source: 'Temu Partner Platform API documentation (public mirror)',
  note: 'Auto-generated endpoint reference. Parameter names/error codes are factual reference data of the Temu Partner API.',
  gateway: {
    hosts: {
      US: 'https://openapi-b-us.temu.com/openapi/router',
      EU: 'https://openapi-b-eu.temu.com/openapi/router',
      GLOBAL: 'https://openapi-b-global.temu.com/openapi/router',
    },
    commonParams: ['type', 'app_key', 'access_token', 'timestamp', 'sign', 'data_type', 'version'],
    rateLimitQps: 20,
  },
  categories: byCategory,
  endpoints,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${endpoints.length} endpoints to ${OUT}`);
console.log(byCategory);
