import { useMemo } from 'react'
import { COLLECTION } from '@/config'
import { formatNumber, formatPercent } from '@/lib/format'
import { raritySummary } from '@/lib/traits'
import { Reveal } from './Reveal'
import { SectionHead } from './SectionHead'

/** Trait distribution computed by running the real generator over the supply. */
export function RaritySection() {
  const summary = useMemo(() => raritySummary(), [])

  return (
    <section className="section" id="rarity">
      <div className="shell">
        <SectionHead
          eyebrow="Rarity"
          title={
            <>
              Counted, not <span className="grad-text">claimed</span>.
            </>
          }
          lede={`These percentages come from running the generator across all ${formatNumber(COLLECTION.maxSupply)} seeds and tallying the results — the same code that renders every card on this page.`}
          aside={<span className="chip chip--cyan">{summary.groups.length} trait groups</span>}
        />

        <Reveal>
          <div className="rarity">
            {summary.groups.map((group) => {
              const entries = summary.byKey[group.key] ?? []
              const max = entries.reduce((m, e) => Math.max(m, e.frequency), 0.0001)
              return (
                <div className="rarity__group" key={group.key}>
                  <h4>{group.name}</h4>
                  {entries.map((entry) => (
                    <div className="rarity__row" key={`${entry.key}:${entry.value}`}>
                      <span className="rarity__name" title={`${entry.count} of ${summary.supply}`}>
                        {entry.value}
                      </span>
                      <span className="rarity__track">
                        <span
                          className="rarity__fill"
                          style={{
                            width: `${Math.max(3, (entry.frequency / max) * 100)}%`,
                            background:
                              entry.frequency <= 0.05
                                ? 'linear-gradient(90deg,var(--lime),var(--cyan))'
                                : entry.frequency <= 0.12
                                  ? 'linear-gradient(90deg,var(--cyan),var(--violet))'
                                  : 'linear-gradient(90deg,var(--coral),var(--mango))',
                          }}
                        />
                      </span>
                      <span className="rarity__pct">
                        {formatPercent(entry.frequency, 1)}
                        <span style={{ color: 'var(--faint)' }}> · {entry.count}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </Reveal>
      </div>
    </section>
  )
}
