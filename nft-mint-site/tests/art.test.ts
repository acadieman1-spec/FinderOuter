/**
 * Renderer tests.
 *
 * jsdom has no canvas backend, so instead of comparing pixels we install a
 * counting 2D context on *every* canvas element (the composition is painted
 * into an offscreen buffer) and assert on the drawing calls: every composition
 * must do real work, every anomaly must composite, quality must change the
 * workload, and the same spec must produce an identical call sequence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearRenderCaches, renderField, renderToken, tokenToDataUrl } from '@/lib/art'
import { COLLECTION } from '@/config'
import {
  ANOMALIES,
  COMPOSITIONS,
  coreOf,
  deriveToken,
  PALETTES,
} from '@/lib/traits'

let calls: string[] = []
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext

function countingContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => calls.push('addColorStop') }
  const state: Record<string | symbol, unknown> = {}

  return new Proxy(state, {
    get(target, prop) {
      if (
        prop === 'createLinearGradient' ||
        prop === 'createRadialGradient' ||
        prop === 'createConicGradient'
      ) {
        return () => {
          calls.push('gradient')
          return gradient
        }
      }
      if (prop === 'createPattern') return () => null
      if (prop === 'createImageData' || prop === 'getImageData') {
        return (w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
        })
      }
      if (prop === 'measureText') return () => ({ width: 10 })
      if (prop in target) return target[prop]
      return (..._args: unknown[]) => {
        calls.push(String(prop))
      }
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  calls = []
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() =>
    countingContext()) as unknown as typeof HTMLCanvasElement.prototype.getContext
  // Cached buffers/tiles were built with the previous context factory.
  clearRenderCaches()
})

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  clearRenderCaches()
})

/** First token id whose generator picked `composition`. */
function tokenIdForComposition(composition: string): number {
  for (let id = 1; id <= COLLECTION.maxSupply; id++) {
    if (coreOf(id).composition === composition) return id
  }
  throw new Error(`no token in the supply uses composition ${composition}`)
}

function tokenIdForAnomaly(anomaly: string): number {
  for (let id = 1; id <= COLLECTION.maxSupply; id++) {
    if (coreOf(id).anomaly === anomaly) return id
  }
  throw new Error(`no token in the supply carries anomaly ${anomaly}`)
}

const SIZE = 96 // call counts do not depend on pixel size

describe('renderer coverage', () => {
  it('does substantial drawing work for every composition', () => {
    const counts: Record<string, number> = {}
    for (const comp of COMPOSITIONS) {
      calls = []
      const spec = coreOf(tokenIdForComposition(comp.id))
      renderField(countingContext(), { spec, size: SIZE, quality: 'full' })
      counts[comp.id] = calls.length

      // Each composition must issue a substantial number of path/gradient calls.
      expect(calls.length, `${comp.name} should paint`).toBeGreaterThan(90)
      expect(calls, comp.name).toContain('fill')
      expect(calls.filter((c) => c === 'gradient').length, comp.name).toBeGreaterThan(2)
      // The offscreen composite step must have happened.
      expect(calls, comp.name).toContain('drawImage')
    }
    // Every composition should be a meaningfully different amount of work.
    expect(new Set(Object.values(counts)).size).toBeGreaterThan(1)
  })

  it('composites every anomaly without throwing', () => {
    for (const anomaly of ANOMALIES) {
      calls = []
      const spec = coreOf(tokenIdForAnomaly(anomaly.id))
      expect(() =>
        renderField(countingContext(), { spec, size: SIZE, quality: 'full' }),
      ).not.toThrow()

      if (anomaly.id === 'ghost_ring') {
        expect(calls.filter((c) => c === 'stroke').length).toBeGreaterThan(4)
      }
      if (anomaly.id === 'prism_fracture') {
        expect(calls).toContain('fillRect')
        expect(calls).toContain('rotate')
      }
      if (anomaly.id === 'void_core') {
        expect(calls.filter((c) => c === 'gradient').length).toBeGreaterThan(3)
      }
      if (anomaly.id === 'chroma_bleed') {
        // Channel split: the buffer is drawn three times (two tinted + one base).
        expect(calls.filter((c) => c === 'drawImage').length).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('renders every palette at least once across the supply', () => {
    const seen = new Set<string>()
    for (let id = 1; id <= COLLECTION.maxSupply; id++) seen.add(coreOf(id).palette.id)
    expect(seen.size).toBe(PALETTES.length)
  })

  it('supports animated frames (time > 0)', () => {
    const spec = coreOf(tokenIdForComposition('flow'))
    const perFrame: number[] = []
    for (let t = 0; t < 4; t++) {
      calls = []
      renderField(countingContext(), { spec, size: SIZE, time: t * 0.25, quality: 'fast' })
      perFrame.push(calls.length)
    }
    expect(perFrame.every((n) => n > 60)).toBe(true)
    // Animated flow renders fewer strokes than a static one.
    calls = []
    renderField(countingContext(), { spec, size: SIZE, time: 0, quality: 'full' })
    const staticCount = calls.length
    expect(perFrame[0]).toBeLessThan(staticCount)
  })

  it('is deterministic: identical specs produce identical call sequences', () => {
    const spec = deriveToken(2024)
    calls = []
    renderField(countingContext(), { spec, size: SIZE, quality: 'full' })
    const a = [...calls]
    clearRenderCaches()
    calls = []
    renderField(countingContext(), { spec, size: SIZE, quality: 'full' })
    const b = [...calls]
    expect(a.length).toBeGreaterThan(90)
    expect(a).toEqual(b)
  })

  it('differs between token ids', () => {
    calls = []
    renderField(countingContext(), { spec: coreOf(11), size: SIZE, quality: 'full' })
    const a = [...calls]
    clearRenderCaches()
    calls = []
    renderField(countingContext(), { spec: coreOf(997), size: SIZE, quality: 'full' })
    expect(a).not.toEqual(calls)
  })

  it('honours the fast quality flag by doing less work', () => {
    for (const comp of COMPOSITIONS) {
      const spec = coreOf(tokenIdForComposition(comp.id))
      clearRenderCaches()
      calls = []
      renderField(countingContext(), { spec, size: SIZE, quality: 'full' })
      const full = calls.length
      clearRenderCaches()
      calls = []
      renderField(countingContext(), { spec, size: SIZE, quality: 'fast' })
      expect(calls.length, `${comp.name}: fast should be cheaper`).toBeLessThan(full)
    }
  })
})

describe('renderer integration with real canvas elements', () => {
  it('sizes the backing store for devicePixelRatio', () => {
    const canvas = document.createElement('canvas')
    Object.defineProperty(canvas, 'clientWidth', { value: 200, configurable: true })
    renderToken(canvas, deriveToken(7), { cssSize: 200 })
    expect(canvas.width).toBeGreaterThanOrEqual(200)
    expect(canvas.height).toBe(canvas.width)
  })

  it('exports a PNG data URL', () => {
    const url = tokenToDataUrl(deriveToken(31), 64)
    expect(url.startsWith('data:image/png')).toBe(true)
  })
})
