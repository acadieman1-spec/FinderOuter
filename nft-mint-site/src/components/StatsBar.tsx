import { COLLECTION } from '@/config'
import { formatNumber } from '@/lib/format'
import { useApp } from '@/state/AppState'
import { Reveal } from './Reveal'

/** Four headline numbers, straight from the active snapshot. */
export function StatsBar() {
  const { snapshot, phase, settings } = useApp()
  const remaining = Math.max(0, snapshot.maxSupply - snapshot.totalMinted)

  const stats = [
    {
      label: 'Fields minted',
      value: formatNumber(snapshot.totalMinted),
      note: `of ${formatNumber(snapshot.maxSupply)} · ${remaining} left`,
    },
    {
      label: 'Holders',
      value: formatNumber(snapshot.holders),
      note: settings.mode === 'demo' ? 'simulated distribution' : 'unique owners',
    },
    {
      label: 'Mint price',
      value: `${phase.priceSol} SOL`,
      note: phase.requiresAllowlist ? 'allowlist rate' : 'public rate',
    },
    {
      label: 'Royalty',
      value: `${COLLECTION.royaltyBps / 100}%`,
      note: 'secondary sales · studio treasury',
    },
  ]

  return (
    <div className="shell">
      <Reveal>
        <div className="stats">
          {stats.map((stat) => (
            <div className="stat" key={stat.label}>
              <div className="stat__label">{stat.label}</div>
              <div className="stat__value">{stat.value}</div>
              <div className="stat__note">{stat.note}</div>
            </div>
          ))}
        </div>
      </Reveal>
    </div>
  )
}
