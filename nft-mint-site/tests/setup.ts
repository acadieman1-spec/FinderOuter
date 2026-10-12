/**
 * jsdom does not implement canvas, scrollIntoView or matchMedia — stub the
 * minimum the app touches so components can be rendered headlessly.
 */

interface GradientStub {
  addColorStop: (offset: number, color: string) => void
}

function contextStub(): Record<string | symbol, unknown> {
  const gradient: GradientStub = { addColorStop: () => undefined }
  const noop = () => undefined
  const target: Record<string | symbol, unknown> = {}

  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient
      if (prop === 'createConicGradient') return () => gradient
      if (prop === 'createPattern') return () => null
      if (prop === 'createImageData')
        return (w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
        })
      if (prop === 'getImageData')
        return (x: number, y: number, w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
        })
      if (prop === 'measureText') return () => ({ width: 42 })
      if (prop === 'canvas') return { width: 512, height: 512 }
      return noop
    },
    set(t, prop, value) {
      t[prop] = value
      return true
    },
  })
}

HTMLCanvasElement.prototype.getContext = (() => contextStub()) as unknown as typeof HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,STUBBED'

Element.prototype.scrollIntoView = function scrollIntoViewStub() {
  /* no-op */
}

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).ResizeObserver = ResizeObserverStub
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  class IntersectionObserverStub {
    root = null
    rootMargin = '0px'
    thresholds = [0]
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).IntersectionObserver = IntersectionObserverStub
}
