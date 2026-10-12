import { PHASE as MINT_PRICE, SCHEDULE } from '@/config'
import { utcLabel } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useApp } from '@/state/AppState'
import { IconCheck } from './Icons'

interface Row {
  name: string
  when: string
  price: string
  state: 'done' | 'active' | 'next'
  note?: string
}

/** Allowlist → public → close, driven by the live phase. */
export function PhaseTimeline() {
  const { phase, snapshot } = useApp()
  const now = Date.now()

  const rows: Row[] = [
    {
      name: 'Allowlist',
      when: utcLabel(SCHEDULE.allowlistStart),
      price: `${MINT_PRICE.allowlistPriceSol} SOL`,
      state:
        phase.phase === 1
          ? 'active'
          : now > SCHEDULE.allowlistStart || phase.phase > 1
            ? 'done'
            : 'next',
      note: `${snapshot.allowlistAllocation} allocation · Merkle-gated`,
    },
    {
      name: 'Public mint',
      when: utcLabel(SCHEDULE.publicStart),
      price: `${MINT_PRICE.publicPriceSol} SOL`,
      state:
        phase.phase === 2
          ? 'active'
          : now > SCHEDULE.publicStart || phase.phase > 2
            ? 'done'
            : 'next',
      note: `max ${snapshot.maxSupply - snapshot.allowlistAllocation} tokens · first come`,
    },
    {
      name: 'Mint closes',
      when: utcLabel(SCHEDULE.endsAt),
      price: '—',
      state: phase.phase === 3 ? 'active' : now > SCHEDULE.endsAt ? 'done' : 'next',
      note: 'Unsold tokens are burned; supply becomes fixed',
    },
  ]

  return (
    <div className="card card-pad">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Phases</span>
          <div className="h3" style={{ marginTop: 8, fontSize: 22 }}>
            {phase.label}
          </div>
        </div>
        <span className={cn('chip', phase.status === 'live' ? 'chip--live' : 'chip--demo')}>
          {phase.status === 'live' ? 'open' : phase.status === 'soldout' ? 'closed' : 'scheduled'}
        </span>
      </div>

      <div className="phases">
        {rows.map((row, i) => (
          <div key={row.name} className={cn('phase', `phase--${row.state}`)}>
            <span className="phase__marker">
              {row.state === 'done' ? <IconCheck size={13} /> : i + 1}
            </span>
            <span>
              <span className="phase__name">{row.name}</span>
              <span className="phase__when">{row.when}</span>
              {row.note ? <span className="phase__when">{row.note}</span> : null}
            </span>
            <span className="phase__price">{row.price}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
