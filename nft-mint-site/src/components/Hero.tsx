import { useEffect, useMemo, useState } from 'react'
import { COLLECTION, NETWORKS } from '@/config'
import { topRarityTokens } from '@/lib/curation'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/cn'
import { tokenLabel } from '@/lib/traits'
import { useApp } from '@/state/AppState'
import { usePrefersReducedMotion } from '@/hooks'
import { ArtCanvas } from './ArtCanvas'
import { Countdown } from './Countdown'
import { IconArrow, IconRefresh, IconSpark } from './Icons'

interface HeroProps {
  onMint: () => void
}

export function Hero({ onMint }: HeroProps) {
  const { phase, snapshot, settings } = useApp()
  const reduced = usePrefersReducedMotion()
  const featured = useMemo(() => topRarityTokens(6), [])
  const [index, setIndex] = useState(0)
  const tokenId = featured[index] ?? 1

  // Slow auto-cycle through the rarest fields unless the visitor opted out.
  useEffect(() => {
    if (reduced || featured.length < 2) return
    const id = window.setInterval(() => setIndex((i) => (i + 1) % featured.length), 9000)
    return () => window.clearInterval(id)
  }, [reduced, featured.length])

  const countdownTarget = phase.nextChangeAt
  const countdownEnded =
    phase.status === 'live' ? 'Mint is live' : phase.status === 'soldout' ? 'Sold out' : 'Opening'
  const pct = Math.min(100, (snapshot.totalMinted / snapshot.maxSupply) * 100)

  return (
    <section className="hero" id="top">
      <div className="shell hero__grid">
        <div>
          <span className="eyebrow">
            {COLLECTION.creator} · {NETWORKS[settings.network].label}
            {settings.mode === 'demo' ? ' · demo mode' : ''}
          </span>

          <h1 className="display hero__title">
            <span className="line">CHROMA</span>
            <span className="line line--outline">FIELD</span>
          </h1>

          <p className="lede hero__lede">{COLLECTION.tagline}</p>

          <div className="hero__facts">
            <span className="chip chip--accent">
              <IconSpark size={13} /> {formatNumber(snapshot.maxSupply)} fields
            </span>
            <span className="chip">{phase.priceSol} SOL</span>
            <span className="chip">max {COLLECTION.maxPerWallet} / wallet</span>
            <span className="chip">generator v{COLLECTION.generatorVersion}</span>
            <span className={cn('chip', phase.status === 'live' ? 'chip--live' : 'chip--demo')}>
              <span className={cn('pulse-dot', phase.status !== 'live' && 'pulse-dot--idle')} />
              {phase.label}
            </span>
          </div>

          <Countdown target={countdownTarget} endedLabel={countdownEnded} />

          <div className="hero__cta">
            <button type="button" className="btn btn--primary btn--lg" onClick={onMint}>
              Mint a field <IconArrow size={17} />
            </button>
            <a className="btn btn--ghost btn--lg" href="#collection">
              Explore the collection
            </a>
          </div>

          <div className="supply" style={{ marginTop: 26, maxWidth: 460 }}>
            <div className="supply__bar">
              <div className="supply__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="supply__legend">
              <span>
                {formatNumber(snapshot.totalMinted)} minted
              </span>
              <span>{formatNumber(snapshot.maxSupply - snapshot.totalMinted)} remaining</span>
            </div>
          </div>
        </div>

        <div className="hero__art">
          <div className="art-frame">
            <span className="art-frame__glow" aria-hidden />
            <span className="art-frame__badge">
              {tokenLabel(tokenId)} · rarity {featured.length ? index + 1 : 1}/{featured.length}
            </span>
            <ArtCanvas tokenId={tokenId} animated={!reduced} fps={26} quality="full" />
            <button
              type="button"
              className="btn btn--ghost btn--sm art-frame__shuffle"
              onClick={() => setIndex((i) => (i + 1) % featured.length)}
              aria-label="Show another field"
            >
              <IconRefresh size={15} /> Shuffle
            </button>
          </div>

          <div className="hero__strip">
            {featured.slice(0, 3).map((id) => (
              <button
                key={id}
                type="button"
                className="mini-art"
                onClick={() => setIndex(featured.indexOf(id))}
                aria-current={id === tokenId}
                aria-label={`Preview ${tokenLabel(id)}`}
              >
                <ArtCanvas tokenId={id} quality="fast" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
