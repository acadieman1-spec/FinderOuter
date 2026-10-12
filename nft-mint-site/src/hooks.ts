/** Small shared hooks. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { timeLeft, type TimeLeft } from './lib/format'

/** Ticking clock, throttled to `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (intervalMs <= 0) return
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

export function useCountdown(target: number, intervalMs = 1000): TimeLeft {
  const now = useNow(intervalMs)
  return useMemo(() => timeLeft(target, now), [target, now])
}

/** IntersectionObserver as a callback ref. */
export function useInView<T extends Element>(options?: {
  threshold?: number
  rootMargin?: string
  once?: boolean
}) {
  const [node, setNode] = useState<T | null>(null)
  const [inView, setInView] = useState(false)
  const once = options?.once ?? false
  const threshold = options?.threshold ?? 0.01
  const rootMargin = options?.rootMargin ?? '0px'

  useEffect(() => {
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting)
        if (entry.isIntersecting && once) observer.disconnect()
      },
      { threshold, rootMargin },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, threshold, rootMargin, once])

  return { ref: setNode, inView }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduced(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])
  return reduced
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const apply = () => setMatches(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [query])
  return matches
}

/** Copy-to-clipboard with a transient "copied" flag. */
export function useCopy(resetMs = 1600) {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const copy = useCallback(
    async (text: string, key?: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
        } else {
          const el = document.createElement('textarea')
          el.value = text
          el.setAttribute('readonly', '')
          el.style.position = 'fixed'
          el.style.opacity = '0'
          document.body.appendChild(el)
          el.select()
          document.execCommand('copy')
          document.body.removeChild(el)
        }
        setCopied(key ?? text)
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(null), resetMs)
        return true
      } catch {
        return false
      }
    },
    [resetMs],
  )

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  return { copied, copy }
}

/** Locks body scroll while `active` (modals / drawer). */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [active])
}

/** Escape-key listener. */
export function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, onEscape])
}
