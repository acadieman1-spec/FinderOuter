import { useEscape, useScrollLock } from '@/hooks'
import { formatSol, shortAddress } from '@/lib/format'
import { explorerUrl } from '@/lib/program'
import { useApp } from '@/state/AppState'
import { ArtCanvas } from './ArtCanvas'
import { IconClose, IconCopy, IconExternal, IconRefresh, IconWallet } from './Icons'
import { WalletGlyph } from './Icons'
import { cn } from '@/lib/cn'
import { useCopy } from '@/hooks'

interface WalletModalProps {
  open: boolean
  onClose: () => void
}

export function WalletModal({ open, onClose }: WalletModalProps) {
  const { wallets, wallet, connecting, connect, disconnect, balanceSol, refreshBalance, settings, myTokens } =
    useApp()
  const { copied, copy } = useCopy()
  useScrollLock(open)
  useEscape(open, onClose)

  if (!open) return null

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        style={{ width: 'min(100%, 468px)' }}
        role="dialog"
        aria-modal="true"
        aria-label={wallet ? 'Wallet' : 'Connect a wallet'}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="btn btn--ghost btn--icon modal__close" onClick={onClose} aria-label="Close">
          <IconClose size={17} />
        </button>

        <div className="modal__body" style={{ padding: 'clamp(22px,3vw,30px)' }}>
          {wallet ? (
            <>
              <div className="row gap-4" style={{ alignItems: 'center' }}>
                <div
                  className="wallet-row__glyph"
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 15,
                    background: wallets.find((w) => w.id === wallet.id)?.accent ?? 'var(--grad-mint)',
                  }}
                >
                  <WalletGlyph id={wallet.id} size={26} />
                </div>
                <div>
                  <div className="h3" style={{ fontSize: 20 }}>
                    {wallet.name}
                  </div>
                  <div className="mono" style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                    {wallet.isDemo ? 'Simulated signer · demo mode' : `${settings.network} · injected provider`}
                  </div>
                </div>
              </div>

              <dl className="kv">
                <div className="kv__row">
                  <dt>Address</dt>
                  <dd>
                    <span className="mono">{shortAddress(wallet.address, 6, 6)}</span>
                    <button
                      type="button"
                      className={cn('copy-btn', copied === wallet.address && 'is-copied')}
                      onClick={() => void copy(wallet.address, wallet.address)}
                      aria-label="Copy address"
                    >
                      <IconCopy size={13} />
                    </button>
                  </dd>
                </div>
                <div className="kv__row">
                  <dt>Balance</dt>
                  <dd>
                    {balanceSol === null ? '—' : `${formatSol(balanceSol)} SOL`}
                    {!wallet.isDemo && settings.mode === 'live' ? (
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={() => void refreshBalance()}
                        aria-label="Refresh balance"
                      >
                        <IconRefresh size={13} />
                      </button>
                    ) : null}
                  </dd>
                </div>
                <div className="kv__row">
                  <dt>Your tokens</dt>
                  <dd>{myTokens.length === 0 ? 'none yet' : myTokens.map((t) => `#${t}`).join(', ')}</dd>
                </div>
              </dl>

              {myTokens.length > 0 ? (
                <div className="receipt__art">
                  {myTokens.slice(0, 6).map((tokenId) => (
                    <figure key={tokenId}>
                      <ArtCanvas tokenId={tokenId} quality="fast" />
                      <figcaption>#{String(tokenId).padStart(4, '0')}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}

              <div className="row gap-3 wrap">
                <a
                  className="btn btn--ghost btn--sm"
                  href={explorerUrl('account', wallet.address, settings.network)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <IconExternal size={15} /> Explorer
                </a>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <span className="eyebrow">Connect</span>
                <h2 className="h3" style={{ marginTop: 12, fontSize: 26 }}>
                  Choose a wallet
                </h2>
                <p className="tiny" style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
                  {settings.mode === 'demo'
                    ? 'Demo Mode is on: the demo wallet signs locally and nothing is broadcast. Injected wallets still work if you have one installed.'
                    : 'We only request a public key. Approve the mint transaction in your wallet when prompted.'}
                </p>
              </div>

              <div className="wallet-list">
                {wallets.map((w) => {
                  const busy = connecting === w.id
                  const disabled = !w.installed
                  return (
                    <button
                      key={w.id}
                      type="button"
                      className="wallet-row"
                      disabled={disabled || connecting !== null}
                      onClick={() => void connect(w.id)}
                    >
                      <span className="wallet-row__glyph" style={{ background: w.accent }}>
                        {w.id === 'demo' ? <IconWallet size={19} /> : <WalletGlyph id={w.id} size={21} />}
                      </span>
                      <span>
                        <span className="wallet-row__name">{w.name}</span>
                        <span className="wallet-row__hint">
                          {disabled ? 'Not detected in this browser' : w.hint}
                        </span>
                      </span>
                      <span className="mono tiny" style={{ fontSize: 11 }}>
                        {busy ? '…' : disabled ? '' : w.id === 'demo' ? 'READY' : 'DETECTED'}
                      </span>
                    </button>
                  )
                })}
              </div>

              <p className="tiny" style={{ fontSize: 12 }}>
                Never share your seed phrase. CHROMAFIELD will never ask for it — the only request you should see is a
                transaction signature or an address verification.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
