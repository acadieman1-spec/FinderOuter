/**
 * <ArtCanvas> — renders a token's field into a canvas.
 *
 * Deterministic per token id. Animates only when `animated`, on screen, and the
 * visitor has not asked for reduced motion; otherwise it paints once at
 * `time = 0` and repaints on resize.
 */

import { useEffect, useMemo, useRef } from 'react'
import { renderToken, type Quality } from '@/lib/art'
import { useInView, usePrefersReducedMotion } from '@/hooks'
import { deriveToken, tokenLabel, type TokenSpec } from '@/lib/traits'

export interface ArtCanvasProps {
  tokenId: number
  className?: string
  animated?: boolean
  quality?: Quality
  /** Frames per second when animating. */
  fps?: number
  /** Expose the derived spec to the parent (traits, palette…). */
  onSpec?: (spec: TokenSpec) => void
  ariaLabel?: string
}

export function ArtCanvas({
  tokenId,
  className,
  animated = false,
  quality = 'full',
  fps = 24,
  onSpec,
  ariaLabel,
}: ArtCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { ref: viewRef, inView } = useInView<HTMLCanvasElement>({ rootMargin: '160px' })
  const reduced = usePrefersReducedMotion()
  const spec = useMemo(() => deriveToken(tokenId), [tokenId])

  useEffect(() => {
    onSpec?.(spec)
  }, [spec, onSpec])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !inView) return

    let raf = 0
    let last = 0
    const startedAt = performance.now()

    const paint = (time: number) => {
      const cssSize = canvas.clientWidth || canvas.clientHeight || 320
      renderToken(canvas, spec, { cssSize, time, quality })
    }

    if (animated && !reduced) {
      const loop = (now: number) => {
        if (now - last >= 1000 / fps) {
          last = now
          paint((now - startedAt) / 1000)
        }
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    } else {
      paint(0)
    }

    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => paint(animated && !reduced ? (performance.now() - startedAt) / 1000 : 0))
        : null
    observer?.observe(canvas)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      observer?.disconnect()
    }
  }, [spec, animated, reduced, quality, fps, inView])

  const label = ariaLabel ?? `CHROMAFIELD token ${tokenLabel(tokenId)}, generated field`

  return (
    <canvas
      ref={(el) => {
        canvasRef.current = el
        viewRef(el)
      }}
      className={className}
      role="img"
      aria-label={label}
    />
  )
}
