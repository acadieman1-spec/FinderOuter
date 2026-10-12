import type { CSSProperties, ReactNode } from 'react'
import { useInView } from '@/hooks'
import { cn } from '@/lib/cn'

interface RevealProps {
  children: ReactNode
  delay?: number
  className?: string
  /** Wrapper element — a div by default. */
  as?: 'div' | 'section' | 'li'
  threshold?: number
  style?: CSSProperties
}

/** Fades + lifts content into view once. */
export function Reveal({
  children,
  delay = 0,
  className,
  as = 'div',
  threshold = 0.12,
  style,
}: RevealProps) {
  const { ref, inView } = useInView<HTMLDivElement>({ once: true, threshold })
  // The polymorphic tag is only ever a container element; keep the ref typed to
  // HTMLDivElement so callers do not have to narrow per tag.
  const Tag = as as 'div'
  return (
    <Tag
      ref={ref}
      className={cn('reveal', inView && 'is-visible', className)}
      style={{ transitionDelay: `${delay}ms`, ...style }}
    >
      {children}
    </Tag>
  )
}
