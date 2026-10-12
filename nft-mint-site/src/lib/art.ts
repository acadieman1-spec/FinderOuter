/**
 * CHROMAFIELD renderer.
 *
 * Pure canvas 2D. Given a `CoreSpec` (see `traits.ts`) and a pixel size it
 * draws the field: base colour wash → composition → anomaly → grain → vignette.
 * The composition is painted into an offscreen buffer first so chromatic
 * anomalies can re-composite it with offsets and blend modes.
 *
 * `time` is optional: pass an advancing number of seconds to animate the
 * hero/lightbox pieces. Everything is deterministic at `time = 0`.
 */

import type { CoreSpec } from './traits'
import { Noise, Rng, clamp, lerp, mixHex, rgba } from './prng'

export type Quality = 'fast' | 'full'

export interface RenderOptions {
  spec: CoreSpec
  size: number
  time?: number
  quality?: Quality
}

const TAU = Math.PI * 2

/* -------------------------------------------------------------- utilities */

function scaled(size: number, ratio: number): number {
  return size * ratio
}

/** Offscreen buffer cache — avoids a per-frame allocation in the hero. */
const buffers = new Map<number, HTMLCanvasElement>()
function buffer(size: number): HTMLCanvasElement {
  const key = Math.round(size)
  let canvas = buffers.get(key)
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = key
    canvas.height = key
    if (buffers.size > 6) buffers.delete(buffers.keys().next().value as number)
    buffers.set(key, canvas)
  }
  return canvas
}

/**
 * Drop the cached offscreen buffers and grain tiles.
 * Useful after rendering many sizes at once, and by the renderer tests (which
 * install their own canvas contexts and need fresh buffers to capture).
 */
export function clearRenderCaches(): void {
  buffers.clear()
  grainCache.clear()
}

/* Grain tiles are cached per (size, seed, grain) — they are the most
 * allocation-heavy part of a render. */
interface GrainTile {
  pattern: CanvasPattern | null
  canvas: HTMLCanvasElement
}
const grainCache = new Map<string, GrainTile>()

function grainTile(spec: CoreSpec, size: number, ctx: CanvasRenderingContext2D): GrainTile {
  const key = `${Math.round(size)}|${spec.seed}|${spec.grain}`
  const hit = grainCache.get(key)
  if (hit) return hit

  const tile = document.createElement('canvas')
  tile.width = 128
  tile.height = 128
  const tctx = tile.getContext('2d')!
  const rng = new Rng(spec.seed ^ 0x5bf03635)
  const density = spec.grain === 'Silky' ? 1400 : spec.grain === 'Textured' ? 3200 : 5200
  const spread = spec.grain === 'Coarse' ? 2 : 1
  const img = tctx.createImageData(128, 128)
  for (let i = 0; i < density; i++) {
    const x = Math.floor(rng.float(0, 128))
    const y = Math.floor(rng.float(0, 128))
    const v = rng.float(0.35, 1)
    for (let dx = 0; dx < spread; dx++) {
      for (let dy = 0; dy < spread; dy++) {
        const idx = (((y + dy) % 128) * 128 + ((x + dx) % 128)) * 4
        img.data[idx] = 255
        img.data[idx + 1] = 255
        img.data[idx + 2] = 255
        img.data[idx + 3] = Math.floor(v * (spec.grain === 'Silky' ? 26 : 46))
      }
    }
  }
  tctx.putImageData(img, 0, 0)
  const tile2: GrainTile = { canvas: tile, pattern: ctx.createPattern(tile, 'repeat') }
  if (grainCache.size > 24) grainCache.delete(grainCache.keys().next().value as string)
  grainCache.set(key, tile2)
  return tile2
}

/* ------------------------------------------------------------- base wash */

function paintWash(ctx: CanvasRenderingContext2D, spec: CoreSpec, size: number, rng: Rng) {
  const { palette } = spec
  const bgGrad = ctx.createLinearGradient(0, 0, size * 0.4, size)
  bgGrad.addColorStop(0, palette.bg)
  bgGrad.addColorStop(1, mixHex(palette.bg, palette.colors[0], 0.16))
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, size, size)

  // Two or three enormous soft colour fields.
  const blobs = spec.density === 'Sparse' ? 2 : spec.density === 'Balanced' ? 3 : 4
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < blobs; i++) {
    const cx = rng.float(0.1, 0.9) * size
    const cy = rng.float(0.1, 0.9) * size
    const r = scaled(size, rng.float(0.35, 0.75) * spec.params.blobScale)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    const color = palette.colors[rng.int(0, palette.colors.length - 1)]
    g.addColorStop(0, rgba(color, 0.42 * spec.params.glow))
    g.addColorStop(0.55, rgba(color, 0.12 * spec.params.glow))
    g.addColorStop(1, rgba(color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, TAU)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
}

/* --------------------------------------------------------- compositions */

function paintFlow(ctx: CanvasRenderingContext2D, spec: CoreSpec, size: number, rng: Rng, t: number) {
  const { palette, params } = spec
  const noise = new Noise(spec.seed)
  const strokes = Math.round(params.particles * (t ? 0.45 : 1))
  const scale = (params.noiseScale * 2.4) / size
  ctx.lineCap = 'round'
  ctx.globalCompositeOperation = 'lighter'

  for (let i = 0; i < strokes; i++) {
    let x = rng.float(-0.05, 1.05) * size
    let y = rng.float(-0.05, 1.05) * size
    const color = palette.colors[rng.int(0, palette.colors.length - 1)]
    const width = scaled(size, 0.0012) * params.strokeScale * rng.float(0.6, 2.4)
    const steps = rng.int(14, 42)
    const stepLen = scaled(size, 0.012)
    ctx.strokeStyle = rgba(color, rng.float(0.1, 0.5) * params.contrast)
    ctx.lineWidth = Math.max(0.6, width)
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let s = 0; s < steps; s++) {
      const angle =
        (noise.fbm(x * scale, y * scale + t * 0.12, 3) + 1) * Math.PI * params.warp * 1.6 +
        params.rotation
      x += Math.cos(angle) * stepLen
      y += Math.sin(angle) * stepLen
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
}

function paintStrata(ctx: CanvasRenderingContext2D, spec: CoreSpec, size: number, rng: Rng, t: number) {
  const { palette, params } = spec
  const noise = new Noise(spec.seed ^ 0x1234)
  const bands = params.bands
  const edges: number[][] = []

  for (let b = 0; b <= bands; b++) {
    const row: number[] = []
    const base = (b / bands) * size + params.offset.y * size
    for (let x = 0; x <= 32; x++) {
      const nx = x / 32
      const warp =
        noise.fbm(nx * params.noiseScale * 1.6, b * 0.7 + t * 0.08, 3) * size * 0.075 * params.warp
      row.push(base + warp + Math.sin(nx * TAU * (1 + b % 3) + params.rotation) * size * 0.012)
    }
    edges.push(row)
  }

  for (let b = 0; b < bands; b++) {
    const top = edges[b]
    const bottom = edges[b + 1]
    const c1 = palette.colors[rng.int(0, palette.colors.length - 1)]
    const c2 = palette.colors[rng.int(0, palette.colors.length - 1)]
    const grad = ctx.createLinearGradient(0, size * 0.1, size, size * 0.9)
    grad.addColorStop(0, rgba(c1, 0.85 * params.contrast))
    grad.addColorStop(1, rgba(c2, 0.72 * params.contrast))
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(0, top[0])
    for (let i = 0; i < top.length; i++) ctx.lineTo((i / (top.length - 1)) * size, top[i])
    for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo((i / (bottom.length - 1)) * size, bottom[i])
    ctx.closePath()
    ctx.fill()

    // Hairline highlight along the top edge.
    ctx.strokeStyle = rgba('#ffffff', rng.float(0.05, 0.28))
    ctx.lineWidth = scaled(size, rng.float(0.0008, 0.003))
    ctx.beginPath()
    for (let i = 0; i < top.length; i++) {
      const x = (i / (top.length - 1)) * size
      if (i === 0) ctx.moveTo(x, top[i])
      else ctx.lineTo(x, top[i])
    }
    ctx.stroke()
  }
}

function paintOrbit(ctx: CanvasRenderingContext2D, spec: CoreSpec, size: number, rng: Rng, t: number) {
  const { palette, params } = spec
  const cx = size * (0.5 + params.offset.x * 0.5)
  const cy = size * (0.5 + params.offset.y * 0.5)

  // Core sphere.
  const coreR = scaled(size, 0.16 * params.blobScale + 0.06)
  const core = ctx.createRadialGradient(
    cx - coreR * 0.35,
    cy - coreR * 0.4,
    coreR * 0.05,
    cx,
    cy,
    coreR,
  )
  core.addColorStop(0, rgba(palette.colors[3 % palette.colors.length], 0.95))
  core.addColorStop(0.5, rgba(palette.colors[0], 0.7))
  core.addColorStop(1, rgba(palette.bg, 0.9))
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, TAU)
  ctx.fill()

  ctx.lineCap = 'round'
  const rings = params.rings
  for (let r = 0; r < rings; r++) {
    const radius = scaled(size, 0.1 + (r / rings) * 0.42 * params.blobScale + 0.04)
    const start = rng.float(0, TAU) + params.rotation + t * (r % 2 === 0 ? 0.12 : -0.09)
    const sweep = rng.float(0.4, 1.9) * Math.PI
    const color = palette.colors[rng.int(0, palette.colors.length - 1)]
    ctx.strokeStyle = rgba(color, rng.float(0.25, 0.85) * params.contrast)
    ctx.lineWidth = scaled(size, rng.float(0.002, 0.02)) * params.strokeScale
    if (rng.chance(0.28)) ctx.setLineDash([scaled(size, 0.008), scaled(size, 0.02)])
    else ctx.setLineDash([])
    ctx.beginPath()
    ctx.ellipse(
      cx,
      cy,
      radius,
      radius * rng.float(0.55, 1),
      rng.float(0, TAU),
      start,
      start + sweep,
    )
    ctx.stroke()

    if (rng.chance(0.5)) {
      const a = rng.float(0, TAU)
      const px = cx + Math.cos(a) * radius
      const py = cy + Math.sin(a) * radius * 0.8
      ctx.setLineDash([])
      ctx.fillStyle = rgba(palette.colors[rng.int(0, palette.colors.length - 1)], 0.95)
      ctx.beginPath()
      ctx.arc(px, py, scaled(size, rng.float(0.004, 0.016)), 0, TAU)
      ctx.fill()
    }
  }
  ctx.setLineDash([])
}

function paintBloom(ctx: CanvasRenderingContext2D, spec: CoreSpec, size: number, rng: Rng, t: number) {
  const { palette, params } = spec
  const cx = size * (0.5 + params.offset.x * 0.4)
  const cy = size * (0.5 + params.offset.y * 0.4)
  const petals = clamp(Math.round(params.layers), 4, 18)
  ctx.globalCompositeOperation = 'lighter'

  for (let ring = 0; ring < 3; ring++) {
    const ringScale = 0.34 - ring * 0.09
    const radius = scaled(size, ringScale * params.blobScale + 0.06)
    const spin = params.rotation + ring * 0.4 + t * (ring % 2 === 0 ? 0.18 : -0.14)
    for (let p = 0; p < petals; p++) {
      const angle = spin + (p / petals) * TAU
      const color = palette.colors[(p + ring) % palette.colors.length]
      const len = radius * rng.float(0.75, 1.25)
      const wide = radius * rng.float(0.16, 0.36)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(angle)
      const grad = ctx.createLinearGradient(0, 0, len, 0)
      grad.addColorStop(0, rgba(color, 0.05))
      grad.addColorStop(0.45, rgba(color, 0.5 * params.contrast))
      grad.addColorStop(1, rgba(mixHex(color, '#ffffff', 0.35), 0.08))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.quadraticCurveTo(len * 0.55, -wide, len, 0)
      ctx.quadraticCurveTo(len * 0.55, wide, 0, 0)
      ctx.fill()
      ctx.restore()
    }
  }

  // Centre bloom.
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, scaled(size, 0.18))
  glow.addColorStop(0, rgba('#ffffff', 0.5 * params.glow))
  glow.addColorStop(0.4, rgba(palette.colors[0], 0.28 * params.glow))
  glow.addColorStop(1, rgba(palette.colors[0], 0))
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(cx, cy, scaled(size, 0.18), 0, TAU)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
}

function paintShards(ctx: CanvasRenderingContext2D, spec: CoreSpec, size: number, rng: Rng) {
  const { palette, params } = spec
  const cols = clamp(Math.round(3 + params.layers * 0.5), 3, 10)
  const rows = cols
  const pts: { x: number; y: number }[][] = []
  const jitter = scaled(size, 0.09) * params.warp

  for (let y = 0; y <= rows; y++) {
    const row: { x: number; y: number }[] = []
    for (let x = 0; x <= cols; x++) {
      const edge = x === 0 || y === 0 || x === cols || y === rows
      row.push({
        x: (x / cols) * size + (edge ? 0 : rng.bell() * jitter) + params.offset.x * size,
        y: (y / rows) * size + (edge ? 0 : rng.bell() * jitter) + params.offset.y * size,
      })
    }
    pts.push(row)
  }

  const tri = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
    const c1 = palette.colors[rng.int(0, palette.colors.length - 1)]
    const c2 = palette.colors[rng.int(0, palette.colors.length - 1)]
    const grad = ctx.createLinearGradient(a.x, a.y, c.x, c.y)
    grad.addColorStop(0, rgba(c1, rng.float(0.55, 0.95) * params.contrast))
    grad.addColorStop(1, rgba(c2, rng.float(0.45, 0.9) * params.contrast))
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(c.x, c.y)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = rgba(palette.bg, 0.55)
    ctx.lineWidth = scaled(size, 0.0016)
    ctx.stroke()
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = pts[y][x]
      const b = pts[y][x + 1]
      const c = pts[y + 1][x + 1]
      const d = pts[y + 1][x]
      if (rng.chance(0.5)) {
        tri(a, b, c)
        tri(a, c, d)
      } else {
        tri(a, b, d)
        tri(b, c, d)
      }
      if (rng.chance(0.06)) {
        ctx.fillStyle = rgba('#ffffff', rng.float(0.08, 0.3))
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.closePath()
        ctx.fill()
      }
    }
  }
}

function paintHalo(ctx: CanvasRenderingContext2D, spec: CoreSpec, size: number, rng: Rng, t: number) {
  const { palette, params } = spec
  const cx = size * (0.5 + params.offset.x * 0.25)
  const cy = size * (0.5 + params.offset.y * 0.25)
  const r = scaled(size, 0.24 * params.blobScale + 0.06)

  // Starfield.
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < params.particles * 0.7; i++) {
    const x = rng.float(0, size)
    const y = rng.float(0, size)
    const rad = scaled(size, rng.float(0.0006, 0.0035))
    ctx.fillStyle = rgba(
      palette.colors[rng.int(0, palette.colors.length - 1)],
      rng.float(0.15, 0.8),
    )
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, TAU)
    ctx.fill()
  }

  // Glow rings.
  const rings = clamp(params.rings, 3, 12)
  for (let i = 0; i < rings; i++) {
    const rr = r + scaled(size, 0.02 + i * 0.026 * params.warp)
    const color = palette.colors[i % palette.colors.length]
    ctx.strokeStyle = rgba(color, (0.5 - i * 0.03) * params.contrast)
    ctx.lineWidth = scaled(size, 0.0035 + rng.float(0, 0.004))
    ctx.shadowBlur = scaled(size, 0.03 * params.glow)
    ctx.shadowColor = rgba(color, 0.6)
    ctx.beginPath()
    ctx.arc(cx, cy, rr, 0, TAU)
    ctx.stroke()
  }
  ctx.shadowBlur = 0

  // Eclipse body.
  const body = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r)
  body.addColorStop(0, rgba(mixHex(palette.bg, '#000000', 0.5), 1))
  body.addColorStop(1, rgba(palette.bg, 1))
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TAU)
  ctx.fill()

  // Rotating highlight arc.
  const start = params.rotation + t * 0.25
  ctx.strokeStyle = rgba('#ffffff', 0.85 * params.glow)
  ctx.lineWidth = scaled(size, 0.006)
  ctx.beginPath()
  ctx.arc(cx, cy, r * 1.005, start, start + Math.PI * 0.55)
  ctx.stroke()
  ctx.globalCompositeOperation = 'source-over'
}

/* ------------------------------------------------------------- anomalies */

function paintAnomaly(
  ctx: CanvasRenderingContext2D,
  spec: CoreSpec,
  size: number,
  rng: Rng,
  t: number,
) {
  const { palette, params } = spec
  switch (spec.anomaly) {
    case 'ghost_ring': {
      ctx.globalCompositeOperation = 'lighter'
      const cx = size * (0.5 + params.offset.x * 0.6)
      const cy = size * (0.5 + params.offset.y * 0.6)
      for (let i = 0; i < 5; i++) {
        ctx.strokeStyle = rgba(palette.colors[i % palette.colors.length], 0.1)
        ctx.lineWidth = scaled(size, 0.02 + i * 0.006)
        ctx.beginPath()
        ctx.arc(cx, cy, scaled(size, 0.12 + i * 0.055) + Math.sin(t + i) * size * 0.004, 0, TAU)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'
      break
    }
    case 'void_core': {
      const cx = size * 0.5
      const cy = size * 0.5
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, scaled(size, 0.28))
      g.addColorStop(0, rgba('#000000', 0.92))
      g.addColorStop(0.6, rgba('#000000', 0.45))
      g.addColorStop(1, rgba('#000000', 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, scaled(size, 0.28), 0, TAU)
      ctx.fill()
      ctx.strokeStyle = rgba(palette.colors[2 % palette.colors.length], 0.5)
      ctx.lineWidth = scaled(size, 0.003)
      ctx.beginPath()
      ctx.arc(cx, cy, scaled(size, 0.1), 0, TAU)
      ctx.stroke()
      break
    }
    case 'prism_fracture': {
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 6; i++) {
        const y = rng.float(0, size)
        const angle = rng.float(-0.35, 0.35)
        ctx.save()
        ctx.translate(0, y)
        ctx.rotate(angle)
        const g = ctx.createLinearGradient(0, 0, size, 0)
        const color = palette.colors[i % palette.colors.length]
        g.addColorStop(0, rgba(color, 0))
        g.addColorStop(0.5, rgba(color, 0.4))
        g.addColorStop(1, rgba(color, 0))
        ctx.fillStyle = g
        ctx.fillRect(0, -scaled(size, 0.004), size, scaled(size, 0.008))
        ctx.restore()
      }
      ctx.globalCompositeOperation = 'source-over'
      break
    }
    case 'chroma_bleed':
      // Handled in the composite step (channel split), nothing to draw here.
      break
    case 'none':
      break
  }
}

/* ----------------------------------------------------------- main render */

/**
 * Scale the continuous parameters down for `fast` renders (grid thumbs and
 * animated frames). Determinism is preserved *within* a quality level; a thumb
 * and a full render of the same token are the same composition, just lighter.
 */
function atQuality(spec: CoreSpec, quality: Quality): CoreSpec {
  if (quality === 'full') return spec
  const p = spec.params
  return {
    ...spec,
    params: {
      ...p,
      particles: Math.max(18, Math.round(p.particles * 0.45)),
      layers: Math.max(3, Math.round(p.layers * 0.7)),
      rings: Math.max(3, Math.round(p.rings * 0.7)),
      bands: Math.max(3, Math.round(p.bands * 0.75)),
    },
  }
}

/** Paint a field into `ctx`. Assumes ctx is already scaled to `size` px. */
export function renderField(
  ctx: CanvasRenderingContext2D,
  { spec: inputSpec, size, time = 0, quality = 'full' }: RenderOptions,
): void {
  const spec = atQuality(inputSpec, quality)
  const rng = new Rng(spec.seed)
  ctx.save()
  ctx.clearRect(0, 0, size, size)
  ctx.globalAlpha = 1

  paintWash(ctx, spec, size, rng)

  // Composition into a buffer so anomalies can re-composite it.
  const buf = buffer(size)
  const bctx = buf.getContext('2d')!
  bctx.clearRect(0, 0, size, size)
  bctx.save()
  if (spec.composition !== 'strata' && spec.composition !== 'shards') {
    bctx.translate(size / 2, size / 2)
    bctx.rotate(spec.params.rotation * 0.12)
    bctx.translate(-size / 2, -size / 2)
  }

  switch (spec.composition) {
    case 'flow':
      paintFlow(bctx, spec, size, rng, time)
      break
    case 'strata':
      paintStrata(bctx, spec, size, rng, time)
      break
    case 'orbit':
      paintOrbit(bctx, spec, size, rng, time)
      break
    case 'bloom':
      paintBloom(bctx, spec, size, rng, time)
      break
    case 'shards':
      paintShards(bctx, spec, size, rng)
      break
    case 'halo':
      paintHalo(bctx, spec, size, rng, time)
      break
  }
  bctx.restore()

  const split = spec.anomaly === 'chroma_bleed' && quality === 'full'
  if (split) {
    const dx = scaled(size, 0.008)
    ctx.globalCompositeOperation = 'lighter'
    ctx.filter = 'url(#none)'
    try {
      ctx.filter = 'saturate(1.6) hue-rotate(-25deg)'
      ctx.globalAlpha = 0.5
      ctx.drawImage(buf, dx, 0)
      ctx.filter = 'saturate(1.6) hue-rotate(25deg)'
      ctx.drawImage(buf, -dx, 0)
    } finally {
      ctx.filter = 'none'
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
  }
  ctx.drawImage(buf, 0, 0)

  paintAnomaly(ctx, spec, size, rng, time)

  // Grain.
  if (quality === 'full' || spec.grain !== 'Silky') {
    const tile = grainTile(spec, size, ctx)
    if (tile.pattern) {
      ctx.save()
      ctx.globalAlpha = spec.grain === 'Coarse' ? 0.5 : 0.32
      ctx.globalCompositeOperation = 'overlay'
      ctx.fillStyle = tile.pattern
      ctx.fillRect(0, 0, size, size)
      ctx.restore()
    }
  }

  // Vignette + contrast lift.
  const vig = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.28,
    size / 2,
    size / 2,
    size * 0.78,
  )
  vig.addColorStop(0, 'rgba(0,0,0,0)')
  vig.addColorStop(1, `rgba(0,0,0,${0.42 * spec.params.contrast})`)
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, size, size)

  ctx.restore()
}

/**
 * Draw token `tokenId` into a canvas element, honouring devicePixelRatio.
 * Returns the spec used, for callers that want to display traits.
 */
export function renderToken(
  canvas: HTMLCanvasElement,
  spec: CoreSpec,
  opts: { cssSize?: number; time?: number; quality?: Quality } = {},
): void {
  const cssSize = opts.cssSize ?? canvas.clientWidth ?? 320
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const px = Math.max(64, Math.round(cssSize * dpr))
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px
    canvas.height = px
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(px / cssSize, 0, 0, px / cssSize, 0, 0)
  renderField(ctx, { spec, size: cssSize, time: opts.time ?? 0, quality: opts.quality ?? 'full' })
}

/** PNG data URL for a token — used for download / share / metadata previews. */
export function tokenToDataUrl(spec: CoreSpec, size = 512): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  renderField(ctx, { spec, size, quality: 'full' })
  return canvas.toDataURL('image/png')
}

/** A smooth 0→1 easing for morph transitions between seeds. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

export { lerp }
