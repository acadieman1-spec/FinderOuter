import { useState } from 'react'
import { FAQ } from '@/config'
import { Reveal } from './Reveal'
import { SectionHead } from './SectionHead'
import { IconChevron } from './Icons'

export function Faq() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <section className="section" id="faq">
      <div className="shell" style={{ maxWidth: 940 }}>
        <SectionHead
          eyebrow="Questions"
          title={
            <>
              The things people <span className="grad-text">actually ask</span>.
            </>
          }
        />
        <div className="faq">
          {FAQ.map((item, i) => {
            const isOpen = open === i
            return (
              <Reveal key={item.q} delay={i * 40}>
                <div className="faq__item" data-open={isOpen}>
                  <button
                    type="button"
                    className="faq__q"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : i)}
                  >
                    {item.q}
                    <IconChevron size={17} />
                  </button>
                  {isOpen ? <div className="faq__a">{item.a}</div> : null}
                </div>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}
