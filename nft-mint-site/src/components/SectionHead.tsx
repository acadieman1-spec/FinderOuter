import type { ReactNode } from 'react'
import { Reveal } from './Reveal'

interface SectionHeadProps {
  eyebrow: string
  title: ReactNode
  lede?: ReactNode
  aside?: ReactNode
}

export function SectionHead({ eyebrow, title, lede, aside }: SectionHeadProps) {
  return (
    <Reveal className="gallery__head" style={{ marginBottom: 30 }}>
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2 className="h2" style={{ marginTop: 14 }}>
          {title}
        </h2>
        {lede ? (
          <p className="lede" style={{ marginTop: 16 }}>
            {lede}
          </p>
        ) : null}
      </div>
      {aside ? <div className="row gap-3 wrap">{aside}</div> : null}
    </Reveal>
  )
}
