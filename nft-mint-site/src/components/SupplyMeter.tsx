import { SCHEDULE } from '@/config'
import { formatNumber, formatPercent, utcLabel } from '@/lib/format'
import { useApp } from '@/state/AppState'

/** Supply progress + allowlist allocation. */
export function SupplyMeter() {
  const { snapshot } = useApp()
  const pct = (snapshot.totalMinted / snapshot.maxSupply) * 100
  const allocation = snapshot.allowlistAllocation || SCHEDULE.allowlistAllocation
  const allowPct = Math.min(100, (snapshot.allowlistMinted / allocation) * 100)

  return (
    <div className="card card-pad">
      <div className="panel-head" style={{ marginBottom: 16 }}>
        <div>
          <span className="eyebrow">Supply</span>
          <div className="h3" style={{ marginTop: 8, fontSize: 22 }}>
            {formatNumber(snapshot.totalMinted)}{' '}
            <span style={{ color: 'var(--faint)' }}>/ {formatNumber(snapshot.maxSupply)}</span>
          </div>
        </div>
        <span className="chip chip--cyan">{formatPercent(pct / 100, 1)} minted</span>
      </div>

      <div className="supply">
        <div className="supply__bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className="supply__fill" style={{ width: `${pct}%` }} />
          <div className="supply__ticks" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
        </div>
        <div className="supply__legend">
          <span>{formatNumber(snapshot.maxSupply - snapshot.totalMinted)} remaining</span>
          <span>{formatNumber(snapshot.holders)} holders</span>
        </div>
      </div>

      <hr className="hairline" style={{ marginBlock: 18 }} />

      <div className="supply">
        <div className="spread">
          <span className="tiny" style={{ letterSpacing: '0.06em' }}>
            ALLOWLIST ALLOCATION
          </span>
          <span className="mono tiny">
            {formatNumber(snapshot.allowlistMinted)} / {formatNumber(allocation)}
          </span>
        </div>
        <div className="supply__bar" style={{ height: 7 }}>
          <div
            className="supply__fill"
            style={{ width: `${allowPct}%`, background: 'linear-gradient(90deg,var(--cyan),var(--lime))' }}
          />
        </div>
        <p className="tiny" style={{ fontSize: 12, lineHeight: 1.6 }}>
          {formatNumber(snapshot.maxSupply - allocation)} tokens are reserved for the public phase, opening{' '}
          {utcLabel(SCHEDULE.publicStart)}.
        </p>
      </div>
    </div>
  )
}
