/**
 * Deterministic PRNG utilities.
 *
 * Everything in CHROMAFIELD is reproducible: a token id + generator version
 * hashes to a 32-bit seed, and every trait, colour and stroke below is drawn
 * from a `mulberry32` stream started from that seed. Same input → same field,
 * on any machine, forever.
 */

/** xmur3 string hash → well-mixed 32-bit seed. */
export function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32 — tiny, fast, good enough distribution for art. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stateful wrapper with the conveniences the renderer needs. */
export class Rng {
  private readonly next01: () => number

  constructor(seed: number | string) {
    this.next01 = mulberry32(typeof seed === 'string' ? hashSeed(seed) : seed)
  }

  float(): number
  float(min: number, max: number): number
  float(min = 0, max = 1): number {
    return min + (max - min) * this.next01()
  }

  /** Inclusive integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1 - Number.EPSILON))
  }

  chance(p: number): boolean {
    return this.next01() < p
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next01() * items.length))]
  }

  /** Weighted pick: weights are relative, need not sum to 1. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0
    for (const w of weights) total += w
    let target = this.next01() * total
    for (let i = 0; i < items.length; i++) {
      target -= weights[i] ?? 0
      if (target <= 0) return items[i]
    }
    return items[items.length - 1]
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next01() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  /** Gaussian-ish, centred on 0, ~±1 range. */
  bell(): number {
    return (this.next01() + this.next01() + this.next01()) / 1.5 - 1
  }
}

/**
 * Value noise on a permutation table — used for flow fields and warp.
 * Cheap and tileable enough for a single canvas.
 */
export class Noise {
  private readonly perm: Uint8Array

  constructor(seed: number) {
    const rng = new Rng(seed)
    this.perm = new Uint8Array(512)
    const base = Array.from({ length: 256 }, (_, i) => i)
    const shuffled = rng.shuffle(base)
    for (let i = 0; i < 512; i++) this.perm[i] = shuffled[i & 255]
  }

  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10)
  }

  private grad(hash: number, x: number, y: number): number {
    switch (hash & 3) {
      case 0:
        return x + y
      case 1:
        return -x + y
      case 2:
        return x - y
      default:
        return -x - y
    }
  }

  /** 2D Perlin-ish noise in roughly [-1, 1]. */
  at(x: number, y: number): number {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const u = this.fade(xf)
    const v = this.fade(yf)
    const aa = this.perm[this.perm[xi] + yi]
    const ab = this.perm[this.perm[xi] + yi + 1]
    const ba = this.perm[this.perm[xi + 1] + yi]
    const bb = this.perm[this.perm[xi + 1] + yi + 1]
    const x1 = lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u)
    const x2 = lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u)
    return lerp(x1, x2, v)
  }

  /** Fractal sum, `octaves` layers. */
  fbm(x: number, y: number, octaves = 3): number {
    let amp = 0.5
    let freq = 1
    let sum = 0
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.at(x * freq, y * freq)
      amp *= 0.5
      freq *= 2
    }
    return sum
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Hex → {r,g,b}. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const n = parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  const to = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
  return `#${to(lerp(ca.r, cb.r, t))}${to(lerp(ca.g, cb.g, t))}${to(lerp(ca.b, cb.b, t))}`
}

/** Relative luminance 0..1 — used for the luminosity trait. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}
