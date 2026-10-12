import { useState } from 'react'
import { NETWORKS, PLACEHOLDER_PROGRAM_ID, type NetworkId } from '@/config'
import { useEscape, useScrollLock } from '@/hooks'
import { cn } from '@/lib/cn'
import { validateProgramId } from '@/lib/program'
import { useApp } from '@/state/AppState'
import { IconAlert, IconClose, IconRefresh } from './Icons'

interface SettingsDrawerProps {
  open: boolean
  onClose: () => void
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const {
    settings,
    updateSettings,
    resetSettings,
    resetDemo,
    refresh,
    refreshing,
    topUpDemo,
    snapshot,
  } = useApp()
  const [programId, setProgramId] = useState(settings.programId)
  useScrollLock(open)
  useEscape(open, onClose)

  const programError = validateProgramId(programId)

  const applyProgramId = () => {
    if (programError) return
    updateSettings({ programId: programId.trim() })
  }

  return (
    <>
      {open ? <div className="drawer__scrim" onClick={onClose} role="presentation" /> : null}
      <aside
        className="drawer"
        data-open={open}
        aria-hidden={!open}
        aria-label="Site settings"
      >
        <div className="drawer__head">
          <div>
            <span className="eyebrow">Configuration</span>
            <h2 className="h3" style={{ fontSize: 22, marginTop: 8 }}>
              Settings
            </h2>
          </div>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close settings">
            <IconClose size={17} />
          </button>
        </div>

        <div className="drawer__body">
          <div className="drawer__section">
            <h4>Mint mode</h4>
            <div className="mode-toggle" role="group" aria-label="Mint mode">
              <button
                type="button"
                aria-pressed={settings.mode === 'demo'}
                onClick={() => updateSettings({ mode: 'demo' })}
              >
                Demo
              </button>
              <button
                type="button"
                aria-pressed={settings.mode === 'live'}
                onClick={() => updateSettings({ mode: 'live' })}
              >
                Live
              </button>
            </div>
            <p className="tiny" style={{ marginTop: 10, lineHeight: 1.65, fontSize: 12.5 }}>
              {settings.mode === 'demo'
                ? 'Demo Mode simulates the wallet, the transaction and the chain state locally. No RPC calls, no extension, no SOL.'
                : 'Live Mode reads the Collection account over RPC and broadcasts wallet-signed transactions. Install Phantom, Solflare or Backpack first.'}
            </p>
          </div>

          <div className="drawer__section">
            <h4>Network</h4>
            <select
              className="select"
              value={settings.network}
              onChange={(e) => updateSettings({ network: e.target.value as NetworkId })}
              aria-label="Solana network"
            >
              {(Object.keys(NETWORKS) as NetworkId[]).map((id) => (
                <option key={id} value={id}>
                  {NETWORKS[id].label} — {NETWORKS[id].rpc}
                </option>
              ))}
            </select>
          </div>

          <div className="drawer__section">
            <h4>Program ID</h4>
            <div className="stack gap-2">
              <input
                className="input"
                value={programId}
                spellCheck={false}
                placeholder={PLACEHOLDER_PROGRAM_ID}
                onChange={(e) => setProgramId(e.target.value)}
                onBlur={applyProgramId}
                aria-label="Mint program address"
              />
              {programError ? (
                <div className="callout callout--error">
                  <IconAlert size={15} />
                  <span>{programError}</span>
                </div>
              ) : null}
              <div className="row gap-2 wrap">
                <button type="button" className="btn btn--ghost btn--sm" onClick={applyProgramId} disabled={Boolean(programError)}>
                  Save address
                </button>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => {
                    setProgramId(PLACEHOLDER_PROGRAM_ID)
                    updateSettings({ programId: PLACEHOLDER_PROGRAM_ID })
                  }}
                >
                  Use placeholder
                </button>
              </div>
              <p className="tiny" style={{ fontSize: 12, lineHeight: 1.6 }}>
                Replace this with the address printed by <span className="mono">anchor deploy</span>. Until then, live
                reads will report that no Collection account exists.
              </p>
            </div>
          </div>

          <div className="drawer__section">
            <h4>RPC endpoint</h4>
            <input
              className="input"
              value={settings.rpcUrl}
              spellCheck={false}
              placeholder={NETWORKS[settings.network].rpc}
              onChange={(e) => updateSettings({ rpcUrl: e.target.value })}
              aria-label="Custom RPC URL"
            />
            <div className="row gap-3" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refresh()} disabled={refreshing}>
                <IconRefresh size={15} className={cn(refreshing && 'btn__spin')} />
                {refreshing ? 'Reading…' : 'Refresh chain data'}
              </button>
              <span className="tiny mono" style={{ fontSize: 11 }}>
                source: {snapshot.source}
                {snapshot.error ? ` · ${snapshot.error.slice(0, 42)}…` : ''}
              </span>
            </div>
          </div>

          <div className="drawer__section">
            <h4>Demo controls</h4>
            <div className="stack gap-4">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.simulateRejection}
                  onChange={(e) => updateSettings({ simulateRejection: e.target.checked })}
                />
                <span className="switch__track">
                  <span className="switch__thumb" />
                </span>
                <span>
                  <span style={{ display: 'block', fontSize: 13.5 }}>Reject wallet signatures</span>
                  <span className="tiny" style={{ fontSize: 12 }}>
                    Exercises the cancelled / rejected error path
                  </span>
                </span>
              </label>

              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.simulateEmptyWallet}
                  onChange={(e) => updateSettings({ simulateEmptyWallet: e.target.checked })}
                />
                <span className="switch__track">
                  <span className="switch__thumb" />
                </span>
                <span>
                  <span style={{ display: 'block', fontSize: 13.5 }}>Simulate empty wallet</span>
                  <span className="tiny" style={{ fontSize: 12 }}>
                    Drops the balance to 0.0004 SOL to test the funding guard
                  </span>
                </span>
              </label>

              <div className="row gap-2 wrap">
                <button type="button" className="btn btn--ghost btn--sm" onClick={topUpDemo}>
                  Top up +10 SOL
                </button>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => {
                    resetDemo()
                  }}
                >
                  Reset demo state
                </button>
              </div>
            </div>
          </div>

          <div className="drawer__section">
            <h4>Reset</h4>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => {
                resetSettings()
                setProgramId(DEFAULT_PROGRAM_ID)
              }}
            >
              Restore defaults
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}

const DEFAULT_PROGRAM_ID = PLACEHOLDER_PROGRAM_ID
