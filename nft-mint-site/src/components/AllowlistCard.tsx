import { useState } from 'react'
import { SCHEDULE } from '@/config'
import { shortAddress, utcLabel } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useApp } from '@/state/AppState'
import { useCopy } from '@/hooks'
import { IconAlert, IconCheck, IconCopy, IconShield } from './Icons'

/**
 * Allowlist gate.
 *
 * Demo mode builds a real Merkle tree around the visitor's wallet so the proof
 * and the signature request are genuine. Live mode reads the root from the
 * on-chain Collection account and verifies a pasted proof against it.
 */
export function AllowlistCard() {
  const { wallet, allowlist, verifyAllowlist, settings } = useApp()
  const { copied, copy } = useCopy()
  const [manualProof, setManualProof] = useState('')

  const isDemo = settings.mode === 'demo'
  const rootShort = allowlist.rootHex ? `0x${allowlist.rootHex.slice(0, 18)}…${allowlist.rootHex.slice(-8)}` : '—'

  return (
    <div className="card card-pad">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Allowlist</span>
          <div className="h3" style={{ marginTop: 8, fontSize: 22 }}>
            Merkle gate
          </div>
          <p className="tiny" style={{ fontSize: 12, marginTop: 4 }}>
            {isDemo
              ? `${SCHEDULE.allowlistAllocation}-address demo tree, rebuilt around your wallet`
              : `Root read from the Collection PDA · closes ${utcLabel(SCHEDULE.publicStart)}`}
          </p>
        </div>
        <span className={cn('chip', allowlist.included ? 'chip--live' : 'chip--demo')}>
          <IconShield size={12} />
          {allowlist.included ? 'verified' : wallet ? 'unverified' : 'no wallet'}
        </span>
      </div>

      <div className="stack gap-3">
        <div className="allow__root">
          <span style={{ color: 'var(--faint)', flex: 'none' }}>root</span>
          <span className="mono">{rootShort}</span>
          {allowlist.rootHex ? (
            <button
              type="button"
              className={cn('copy-btn', copied === 'root' && 'is-copied')}
              style={{ marginLeft: 'auto' }}
              onClick={() => void copy(`0x${allowlist.rootHex}`, 'root')}
              aria-label="Copy Merkle root"
            >
              <IconCopy size={13} />
            </button>
          ) : null}
        </div>

        {allowlist.proof.length > 0 ? (
          <div className="proof-list">
            {allowlist.proof.slice(0, 6).map((step, i) => (
              <div key={step}>
                <b>{String(i).padStart(2, '0')}</b> 0x{step.slice(0, 24)}…
              </div>
            ))}
            {allowlist.proof.length > 6 ? <div>…{allowlist.proof.length - 6} more steps</div> : null}
          </div>
        ) : null}

        {!isDemo ? (
          <label className="field">
            <span className="field__label">Paste your proof (hex, comma or newline separated)</span>
            <textarea
              className="textarea"
              value={manualProof}
              placeholder="0x8f3a…, 0x1c02…"
              onChange={(e) => setManualProof(e.target.value)}
              spellCheck={false}
            />
          </label>
        ) : null}

        {allowlist.error ? (
          <div className="callout callout--error">
            <IconAlert size={15} />
            <span>{allowlist.error}</span>
          </div>
        ) : null}

        {allowlist.included ? (
          <div className="callout callout--ok">
            <IconCheck size={15} />
            <span>
              Spot confirmed — {allowlist.proof.length}-step proof matches the root. Allowlist pricing applies until{' '}
              {utcLabel(SCHEDULE.publicStart)}.
            </span>
          </div>
        ) : null}

        <div className="row gap-3 wrap">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!wallet || allowlist.checking}
            onClick={() =>
              void verifyAllowlist(
                isDemo
                  ? undefined
                  : manualProof
                      .split(/[\s,]+/)
                      .map((p) => p.replace(/^0x/, '').trim())
                      .filter((p) => p.length === 64),
              )
            }
          >
            <IconShield size={15} />
            {allowlist.checking
              ? 'Verifying…'
              : isDemo
                ? 'Verify my spot (signs a message)'
                : 'Verify proof'}
          </button>
          {wallet ? (
            <span className="tiny mono" style={{ fontSize: 11.5 }}>
              {shortAddress(wallet.address, 5, 5)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
