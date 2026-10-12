import { useMemo, useState } from 'react'
import { COLLECTION } from '@/config'
import { cn } from '@/lib/cn'
import { coreOf, traitsFor, tokenLabel, COMPOSITIONS, PALETTES } from '@/lib/traits'
import { ArtCanvas } from './ArtCanvas'
import { SectionHead } from './SectionHead'
import { Reveal } from './Reveal'
import { TokenModal } from './TokenModal'
import { IconRefresh, IconSpark } from './Icons'

export function rarityClass(score: number): string {
  if (score >= 85) return 'rarity-1'
  if (score >= 70) return 'rarity-2'
  if (score >= 45) return 'rarity-3'
  return 'rarity-4'
}

const PAGE = 12

/** Browsable slice of the supply with composition / palette filters. */
export function Gallery() {
  const [composition, setComposition] = useState<string>('all')
  const [palette, setPalette] = useState<string>('all')
  const [sort, setSort] = useState<'rarity' | 'id'>('rarity')
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<number | null>(null)

  const matches = useMemo(() => {
    const out: number[] = []
    for (let id = 1; id <= COLLECTION.maxSupply; id++) {
      const core = coreOf(id)
      if (composition !== 'all' && core.composition !== composition) continue
      if (palette !== 'all' && core.palette.id !== palette) continue
      out.push(id)
    }
    out.sort((a, b) =>
      sort === 'rarity' ? traitsFor(b).rarityScore - traitsFor(a).rarityScore : a - b,
    )
    return out
  }, [composition, palette, sort])

  const visible = matches.slice(0, limit)

  return (
    <section className="section" id="collection">
      <div className="shell">
        <SectionHead
          eyebrow="The library"
          title={
            <>
              Every field is <span className="grad-text">grown</span>,
              <br />
              not uploaded.
            </>
          }
          lede={`${COLLECTION.maxSupply.toLocaleString('en-US')} tokens, each a seed fed through the same renderer you are looking at. Filter by composition or palette — rarity is counted from the real distribution, not a promise.`}
          aside={
            <>
              <span className="chip chip--cyan">
                <IconSpark size={12} /> {matches.length.toLocaleString('en-US')} match
              </span>
              <select
                className="select"
                style={{ width: 'auto', minWidth: 168 }}
                value={sort}
                onChange={(e) => setSort(e.target.value as 'rarity' | 'id')}
                aria-label="Sort tokens"
              >
                <option value="rarity">Sort · rarest first</option>
                <option value="id">Sort · token number</option>
              </select>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setComposition(COMPOSITIONS[Math.floor(Math.random() * COMPOSITIONS.length)].id)
                  setPalette(PALETTES[Math.floor(Math.random() * PALETTES.length)].id)
                  setLimit(PAGE)
                }}
              >
                <IconRefresh size={15} /> Surprise me
              </button>
            </>
          }
        />

        <Reveal className="filters" style={{ marginBottom: 22 }}>
          <button
            type="button"
            className="filter"
            aria-pressed={composition === 'all'}
            onClick={() => {
              setComposition('all')
              setLimit(PAGE)
            }}
          >
            All compositions
          </button>
          {COMPOSITIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="filter"
              aria-pressed={composition === c.id}
              onClick={() => {
                setComposition(c.id)
                setLimit(PAGE)
              }}
            >
              {c.name}
            </button>
          ))}
          <select
            className="select"
            style={{ width: 'auto', minWidth: 172 }}
            value={palette}
            onChange={(e) => {
              setPalette(e.target.value)
              setLimit(PAGE)
            }}
            aria-label="Filter by palette"
          >
            <option value="all">All palettes</option>
            {PALETTES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Reveal>

        <div className="grid">
          {visible.map((id, i) => {
            const core = coreOf(id)
            const { traits, rarityScore } = traitsFor(id)
            const anomaly = traits.find((t) => t.key === 'anomaly')
            return (
              <Reveal key={id} delay={Math.min(i, 8) * 45}>
                <button type="button" className="token" onClick={() => setOpen(id)}>
                  <span className="token__art">
                    <ArtCanvas tokenId={id} quality="fast" />
                    <span className="token__id">{tokenLabel(id)}</span>
                    <span className={cn('token__rarity', rarityClass(rarityScore))}>
                      rarity {rarityScore}
                    </span>
                  </span>
                  <span className="token__body">
                    <span className="token__traits">
                      <span className="trait-pill">
                        <b>{core.palette.name}</b>
                      </span>
                      <span className="trait-pill">{core.compositionName}</span>
                      {anomaly && anomaly.value !== 'None' ? (
                        <span className="trait-pill rarity-4">
                          <b>{anomaly.value}</b>
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </Reveal>
            )
          })}
        </div>

        {matches.length > visible.length ? (
          <div className="row" style={{ justifyContent: 'center', marginTop: 30 }}>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setLimit((l) => l + PAGE)}
            >
              Load {Math.min(PAGE, matches.length - visible.length)} more
            </button>
          </div>
        ) : null}

        {matches.length === 0 ? (
          <p className="lede" style={{ marginTop: 30 }}>
            No fields match that combination — the generator never produced one. Try another filter.
          </p>
        ) : null}
      </div>

      {open !== null ? <TokenModal tokenId={open} onClose={() => setOpen(null)} /> : null}
    </section>
  )
}
