/**
 * charts.js — tiny dependency-free SVG chart helpers.
 * Everything is generated as markup so the dashboard stays a static bundle.
 */

const fmtNum = (n, digits = 0) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmt = {
  num: (n, d = 0) => fmtNum(n, d),
  money: (n, currency = 'USD', d = 0) => {
    const v = Number(n || 0);
    const abs = Math.abs(v);
    const short = abs >= 1_000_000 ? `${fmtNum(v / 1_000_000, 2)}M`
      : abs >= 10_000 ? `${fmtNum(v / 1000, 1)}K`
      : fmtNum(v, d);
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: d }).format(v).replace(/\d[\d,.]*/, short);
    } catch {
      return `${short} ${currency}`;
    }
  },
  pct: (n, d = 1) => `${fmtNum(n, d)}%`,
  ratio: (n, d = 2) => `${fmtNum(n, d)}×`,
  when: (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`;
  },
  date: (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '—'),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * Multi-series line/area chart.
 * series: [{ name, color, values: number[], area?: boolean, dashed?: boolean }]
 */
export function lineChart({ labels, series, height = 210, currency, valueFormat, yTicks = 4 }) {
  const w = 760, h = height, padL = 52, padR = 14, padT = 12, padB = 26;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const max = niceMax(Math.max(...all, 0) * 1.08);
  const n = Math.max(labels.length - 1, 1);
  const x = (i) => padL + (i / n) * innerW;
  const y = (v) => padT + innerH - (Math.max(v, 0) / max) * innerH;
  const line = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = (max / yTicks) * i;
    return `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${w - padR}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,.06)"/>
      <text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" fill="#667289" font-size="10">${valueFormat ? valueFormat(v) : fmtNum(v, 0)}</text>`;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(labels.length / 8));
  const xLabels = labels.map((l, i) =>
    i % labelEvery === 0 || i === labels.length - 1
      ? `<text x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="#667289" font-size="10">${esc(String(l).slice(5))}</text>`
      : '').join('');

  const paths = series.map((s) => {
    const d = line(s.values);
    const area = s.area
      ? `<path d="${d} L${x(s.values.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${padL},${(padT + innerH).toFixed(1)} Z" fill="${s.color}" opacity=".13"/>`
      : '';
    return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"
      ${s.dashed ? 'stroke-dasharray="5 4"' : ''}/>${s.values.map((v, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${s.color}"><title>${esc(s.name)} · ${esc(labels[i])}: ${valueFormat ? valueFormat(v) : v}</title></circle>`).join('')}`;
  }).join('');

  const legend = series.map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    ${gridLines}${xLabels}${paths}
  </svg><div class="legend">${legend}</div>`;
}

/** Simple grouped bar chart for daily volume. */
export function barChart({ labels, values, color = '#ff7a45', height = 150, valueFormat }) {
  const w = 760, h = height, padL = 46, padR = 10, padT = 10, padB = 24;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const max = niceMax(Math.max(...values, 0) * 1.1);
  const bw = innerW / Math.max(values.length, 1);
  const bars = values.map((v, i) => {
    const bh = (Math.max(v, 0) / max) * innerH;
    const x = padL + i * bw + bw * 0.16;
    const bwid = bw * 0.68;
    return `<rect x="${x.toFixed(1)}" y="${(padT + innerH - bh).toFixed(1)}" width="${bwid.toFixed(1)}" height="${bh.toFixed(1)}"
      rx="3" fill="${color}" opacity=".85"><title>${esc(labels[i])}: ${valueFormat ? valueFormat(v) : v}</title></rect>`;
  }).join('');
  const grid = Array.from({ length: 3 }, (_, i) => {
    const v = (max / 2) * i;
    const y = padT + innerH - (v / max) * innerH;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.06)"/>
      <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#667289" font-size="10">${valueFormat ? valueFormat(v) : fmtNum(v)}</text>`;
  }).join('');
  const labelEvery = Math.max(1, Math.ceil(labels.length / 10));
  const xLabels = labels.map((l, i) => (i % labelEvery === 0 ? `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${h - 7}" text-anchor="middle" fill="#667289" font-size="10">${esc(String(l).slice(5))}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${grid}${bars}${xLabels}</svg>`;
}

/** Horizontal bar list, e.g. top regions / top goods. */
export function barList(items, { valueKey = 'value', labelKey = 'name', color = '#5aa9ff', format = fmtNum, max = 8 } = {}) {
  const rows = items.slice(0, max);
  const top = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
  if (!rows.length) return '<p class="hint">No data for this panel yet.</p>';
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row">
      <span class="dim nowrap" title="${esc(r[labelKey])}">${esc(String(r[labelKey]).slice(0, 16))}</span>
      <span class="bar"><i style="width:${((Number(r[valueKey]) || 0) / top * 100).toFixed(1)}%;background:${color}"></i></span>
      <span class="right mono">${format(Number(r[valueKey]) || 0)}</span>
    </div>`).join('')}</div>`;
}

/** Funnel: impressions -> clicks -> carts -> orders. */
export function funnel(steps) {
  if (!steps?.length || !steps[0].value) return '<p class="hint">No ad funnel data yet — the ads report returned nothing.</p>';
  return `<div class="funnel">${steps.map((s) => `
    <div class="step">
      <span class="dim">${esc(s.stage)}</span>
      <span class="track"><i style="width:${Math.max((s.value / steps[0].value) * 100, 2).toFixed(1)}%"></i></span>
    </div>
    <div class="step"><span></span><span class="mono dim" style="font-size:11px">${fmtNum(s.value)}${s.rate !== undefined ? ` · ${fmt.pct(s.rate)}` : ''}</span></div>
  `).join('')}</div>`;
}

/** Sparkline for KPI cards. */
export function sparkline(values, color = '#37d39b', width = 120, height = 30) {
  if (!values?.length) return '';
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = max - min || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(values.length - 1, 1) * width).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="overflow:visible">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`;
}
