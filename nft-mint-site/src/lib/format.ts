/** Small formatting helpers shared across the UI. */

export function shortAddress(address: string, head = 4, tail = 4): string {
  if (!address) return ''
  if (address.length <= head + tail + 1) return address
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}

export function formatSol(value: number, digits = 3): string {
  const fixed = value.toFixed(digits)
  return fixed.replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m)) || '0'
}

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / 1e9
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9))
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

export interface TimeLeft {
  days: number
  hours: number
  minutes: number
  seconds: number
  total: number
  past: boolean
}

export function timeLeft(target: number, now: number = Date.now()): TimeLeft {
  const total = Math.max(0, target - now)
  return {
    days: Math.floor(total / 86_400_000),
    hours: Math.floor(total / 3_600_000) % 24,
    minutes: Math.floor(total / 60_000) % 60,
    seconds: Math.floor(total / 1000) % 60,
    total,
    past: total === 0,
  }
}

export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - timestamp)
  if (delta < 5_000) return 'just now'
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

export function utcLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC'
}

/** Random-looking but valid base58-ish blob for simulated signatures. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function fakeSignature(seed: number): string {
  let s = seed >>> 0
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  let out = ''
  for (let i = 0; i < 88; i++) out += B58[Math.floor(next() * B58.length)]
  return out
}

export function fakeSlot(seed: number): number {
  return 348_201_447 + (seed % 90_000)
}
