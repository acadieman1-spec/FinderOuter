import { COLLECTION, SCHEDULE } from '@/config'
import { relativeTime, shortAddress, utcLabel } from '@/lib/format'
import { useApp } from '@/state/AppState'
import { useNow } from '@/hooks'

const FALLBACK = [
  `Allowlist open since ${utcLabel(SCHEDULE.allowlistStart)}`,
  `${COLLECTION.maxSupply.toLocaleString('en-US')} fields · ${COLLECTION.priceSol} SOL`,
  `Generator v${COLLECTION.generatorVersion} · deterministic on every device`,
  'Public phase opens ' + utcLabel(SCHEDULE.publicStart),
  'Metadata + seed stored on-chain — no IPFS pinning required',
]

/** Full-bleed marquee of live mint activity (or collection facts when idle). */
export function Ticker() {
  const { activity, snapshot, settings } = useApp()
  const now = useNow(5000)

  const items =
    activity.length > 0
      ? activity.slice(0, 12).map((entry) => ({
          id: entry.id,
          text: entry.address
            ? `${shortAddress(entry.address)} minted #${String(entry.tokenId).padStart(4, '0')}`
            : `mint confirmed${entry.tokenId ? ` #${String(entry.tokenId).padStart(4, '0')}` : ''}`,
          meta: entry.signature ? shortAddress(entry.signature, 4, 4) : relativeTime(entry.at, now),
        }))
      : [
          ...FALLBACK.map((text, i) => ({ id: `f-${i}`, text, meta: settings.mode === 'demo' ? 'demo feed' : snapshot.source })),
        ]

  // Duplicate for a seamless -50% marquee loop.
  const loop = [...items, ...items]

  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker__track">
        {loop.map((item, i) => (
          <span className="ticker__item" key={`${item.id}-${i}`}>
            <span className="ticker__dot" />
            <strong>{item.text}</strong>
            <span>{item.meta}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
