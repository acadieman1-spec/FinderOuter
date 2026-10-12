import { useCopy, useEscape, usePrefersReducedMotion, useScrollLock } from '@/hooks'
import { tokenToDataUrl } from '@/lib/art'
import { cn } from '@/lib/cn'
import { formatPercent } from '@/lib/format'
import { deriveToken, GENERATOR_VERSION, tokenLabel } from '@/lib/traits'
import { ArtCanvas } from './ArtCanvas'
import { rarityClass } from './Gallery'
import { IconClose, IconCopy, IconDownload } from './Icons'

interface TokenModalProps {
  tokenId: number
  onClose: () => void
}

export function TokenModal({ tokenId, onClose }: TokenModalProps) {
  const spec = deriveToken(tokenId)
  const reduced = usePrefersReducedMotion()
  const { copied, copy } = useCopy()
  useScrollLock(true)
  useEscape(true, onClose)

  const seedHex = `0x${spec.seed.toString(16).padStart(8, '0')}`

  const download = () => {
    const url = tokenToDataUrl(spec, 1600)
    const a = document.createElement('a')
    a.href = url
    a.download = `chromafield-${tokenLabel(tokenId).replace('#', '')}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${tokenLabel(tokenId)} detail`}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="btn btn--ghost btn--icon modal__close" onClick={onClose} aria-label="Close">
          <IconClose size={17} />
        </button>

        <div className="modal__grid">
          <div className="modal__art">
            <ArtCanvas tokenId={tokenId} animated={!reduced} fps={22} quality="full" />
          </div>

          <div className="modal__body">
            <div>
              <span className="eyebrow">{spec.palette.name} · {spec.compositionName}</span>
              <h2 className="h2" style={{ fontSize: 'clamp(34px,4.6vw,52px)', marginTop: 12 }}>
                {tokenLabel(tokenId)}
              </h2>
              <div className="row gap-3" style={{ marginTop: 14 }}>
                <span className={cn('chip', rarityClass(spec.rarityScore))}>
                  rarity score {spec.rarityScore}
                </span>
                <span className="chip">generator v{GENERATOR_VERSION}</span>
                {spec.anomaly !== 'none' ? <span className="chip chip--accent">{spec.anomalyName}</span> : null}
              </div>
            </div>

            <div className="trait-table">
              {spec.traits.map((trait) => (
                <div className="trait-row" key={trait.key}>
                  <span className="trait-row__key">{trait.name}</span>
                  <span className="trait-row__val">{trait.value}</span>
                  <span className="trait-row__pct">
                    {formatPercent(trait.frequency, 1)}
                    <span style={{ color: 'var(--faint)' }}> · {trait.count}</span>
                  </span>
                </div>
              ))}
            </div>

            <dl className="kv">
              <div className="kv__row">
                <dt>Seed</dt>
                <dd>
                  <span>{seedHex}</span>
                  <button
                    type="button"
                    className={cn('copy-btn', copied === seedHex && 'is-copied')}
                    onClick={() => void copy(seedHex, seedHex)}
                    aria-label="Copy seed"
                  >
                    <IconCopy size={13} />
                  </button>
                </dd>
              </div>
              <div className="kv__row">
                <dt>Layers</dt>
                <dd>{spec.params.layers}</dd>
              </div>
              <div className="kv__row">
                <dt>Particles</dt>
                <dd>{spec.params.particles}</dd>
              </div>
              <div className="kv__row">
                <dt>Rotation</dt>
                <dd>{((spec.params.rotation * 180) / Math.PI).toFixed(1)}°</dd>
              </div>
              <div className="kv__row">
                <dt>Warp / glow</dt>
                <dd>
                  {spec.params.warp.toFixed(2)} · {spec.params.glow.toFixed(2)}
                </dd>
              </div>
            </dl>

            <div className="row gap-3 wrap">
              <button type="button" className="btn btn--ghost btn--sm" onClick={download}>
                <IconDownload size={15} /> Save 1600px PNG
              </button>
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => void copy(seedHex, seedHex)}>
                <IconCopy size={14} /> Copy seed
              </button>
            </div>

            <p className="tiny" style={{ fontSize: 12, lineHeight: 1.6 }}>
              Token numbers are assigned by the program in mint order — you cannot pick a seed. This view is what any
              holder can reproduce from the seed stored on-chain.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
