import { ROADMAP } from '@/config'
import { cn } from '@/lib/cn'
import { useApp } from '@/state/AppState'
import { Reveal } from './Reveal'
import { SectionHead } from './SectionHead'

export function Roadmap() {
  const { snapshot } = useApp()
  const pct = (snapshot.totalMinted / snapshot.maxSupply) * 100
  /** A milestone counts as reached once the mint has passed its percentage. */
  const reached = (at: string) => pct >= Number(at.replace('%', ''))

  return (
    <section className="section" id="roadmap">
      <div className="shell">
        <SectionHead
          eyebrow="Roadmap"
          title={
            <>
              Tied to <span className="grad-text">supply</span>, not promises.
            </>
          }
          lede={`Milestones unlock on minted supply — currently at ${pct.toFixed(1)}%. Nothing here depends on a secondary market floor.`}
          aside={<span className="chip chip--cyan">{snapshot.totalMinted.toLocaleString('en-US')} / {snapshot.maxSupply.toLocaleString('en-US')} minted</span>}
        />

        <Reveal>
          <div className="roadmap">
            {ROADMAP.map((item) => {
              const done = reached(item.at) || item.done
              return (
                <div key={item.at} className={cn('milestone', done && 'milestone--done')}>
                  <span className="milestone__dot" />
                  <span className="milestone__at">{item.at} MINTED</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              )
            })}
          </div>
        </Reveal>
      </div>
    </section>
  )
}
