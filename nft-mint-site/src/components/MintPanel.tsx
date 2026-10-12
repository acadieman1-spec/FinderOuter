import { useMemo, useState } from 'react'
import { COLLECTION, NETWORKS, PHASE as MINT_PRICE } from '@/config'
import { cn } from '@/lib/cn'
import { formatNumber, formatSol, shortAddress } from '@/lib/format'
import { tokenToDataUrl } from '@/lib/art'
import { explorerUrl, MINT_ACCOUNT_SPACE, rentExemptLamports } from '@/lib/program'
import { STAGE_LABEL, STAGE_ORDER, type MintStage } from '@/lib/mint'
import { deriveToken, tokenLabel } from '@/lib/traits'
import { useApp } from '@/state/AppState'
import { ArtCanvas } from './ArtCanvas'
import {
  IconAlert,
  IconArrow,
  IconBolt,
  IconCheck,
  IconCopy,
  IconDownload,
  IconExternal,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconShield,
  IconWallet,
} from './Icons'
import { useCopy } from '@/hooks'

/** Rent for the accounts a mint creates + a base transaction fee. */
const ACCOUNT_RENT_SOL =
  Number(rentExemptLamports(MINT_ACCOUNT_SPACE) + 2_039_280n + 1_500_000n) / 1e9
const TX_FEE_SOL = 0.000005

interface MintPanelProps {
  onConnectWallet: () => void
}

export function MintPanel({ onConnectWallet }: MintPanelProps) {
  const {
    wallet,
    settings,
    phase,
    snapshot,
    balanceSol,
    allowlist,
    verifyAllowlist,
    attempt,
    minting,
    receipt,
    startMint,
    cancelMint,
    dismissReceipt,
    topUpDemo,
  } = useApp()
  const { copied, copy } = useCopy()

  const remaining = Math.max(0, snapshot.maxSupply - snapshot.totalMinted)
  const cap = Math.max(1, Math.min(COLLECTION.maxPerWallet, remaining))
  const [qty, setQty] = useState(1)
  const effectiveQty = Math.min(qty, cap)

  const usingAllowlist = phase.requiresAllowlist && allowlist.included
  const priceSol = usingAllowlist ? MINT_PRICE.allowlistPriceSol : phase.priceSol
  const subtotal = priceSol * effectiveQty
  const fees = (ACCOUNT_RENT_SOL + TX_FEE_SOL) * effectiveQty
  const total = subtotal + fees

  const insufficient = balanceSol !== null && total > balanceSol
  const network = NETWORKS[settings.network]
  const isDemo = settings.mode === 'demo' || Boolean(wallet?.isDemo)

  const cta = useMemo(() => {
    if (minting) return attempt ? STAGE_LABEL[attempt.stage] : 'Minting…'
    if (!wallet) return 'Connect wallet'
    if (phase.status === 'soldout') return 'Sold out'
    if (snapshot.paused) return 'Minting paused'
    if (!phase.canMint) return phase.status === 'upcoming' ? 'Mint not open yet' : 'Mint closed'
    if (insufficient) return 'Insufficient SOL'
    if (phase.requiresAllowlist && !allowlist.included) return 'Verify allowlist spot'
    return `Mint ${effectiveQty} ${effectiveQty === 1 ? 'field' : 'fields'}`
  }, [
    minting,
    attempt,
    wallet,
    phase,
    snapshot.paused,
    insufficient,
    allowlist.included,
    effectiveQty,
  ])

  const disabled =
    minting ||
    !phase.canMint ||
    snapshot.paused ||
    remaining === 0 ||
    (Boolean(wallet) && insufficient)

  const onPrimary = async () => {
    if (!wallet) {
      onConnectWallet()
      return
    }
    if (phase.requiresAllowlist && !allowlist.included) {
      await verifyAllowlist()
      return
    }
    await startMint(effectiveQty)
  }

  const savePng = (tokenId: number) => {
    const url = tokenToDataUrl(deriveToken(tokenId), 1024)
    const a = document.createElement('a')
    a.href = url
    a.download = `chromafield-${tokenLabel(tokenId).replace('#', '')}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="card card-pad mint-card" id="mint-panel">
      <span className="mint-card__glow" aria-hidden />

      <div className="panel-head">
        <div>
          <span className="eyebrow">{isDemo ? 'Demo mint' : `Live mint · ${network.label}`}</span>
          <h2 className="h3" style={{ marginTop: 8, fontSize: 24 }}>
            {phase.label}
          </h2>
        </div>
        <span className={cn('chip', phase.status === 'live' ? 'chip--live' : 'chip--demo')}>
          <span className={cn('pulse-dot', phase.status !== 'live' && 'pulse-dot--idle')} />
          {phase.status === 'live' ? 'open' : phase.status}
        </span>
      </div>

      {receipt ? (
        <div className="receipt">
          <div className="callout callout--ok">
            <IconCheck size={16} />
            <span>
              {receipt.tokenIds.length === 1
                ? `Token ${tokenLabel(receipt.tokenIds[0])} minted`
                : `${receipt.tokenIds.length} tokens minted`}{' '}
              in {(receipt.elapsedMs / 1000).toFixed(1)}s
              {receipt.demo ? ' (simulated — nothing was broadcast)' : ' and confirmed on-chain'}.
            </span>
          </div>

          <div className="receipt__art">
            {receipt.tokenIds.map((tokenId) => (
              <figure key={tokenId}>
                <ArtCanvas tokenId={tokenId} quality="fast" />
                <figcaption>{tokenLabel(tokenId)}</figcaption>
              </figure>
            ))}
          </div>

          <dl className="kv">
            {receipt.signatures.map((sig) => (
              <div className="kv__row" key={sig}>
                <dt>Signature</dt>
                <dd>
                  <span>{shortAddress(sig, 6, 6)}</span>
                  <button
                    type="button"
                    className={cn('copy-btn', copied === sig && 'is-copied')}
                    onClick={() => void copy(sig, sig)}
                    aria-label="Copy signature"
                  >
                    <IconCopy size={13} />
                  </button>
                  <a
                    className="copy-btn"
                    href={explorerUrl('tx', sig, settings.network)}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label="View transaction"
                    onClick={(e) => {
                      if (isDemo) e.preventDefault()
                    }}
                    title={isDemo ? 'Simulated signature — no explorer entry exists' : 'View on explorer'}
                  >
                    <IconExternal size={13} />
                  </a>
                </dd>
              </div>
            ))}
            <div className="kv__row">
              <dt>Total paid</dt>
              <dd>{formatSol(receipt.totalSol, 3)} SOL</dd>
            </div>
            <div className="kv__row">
              <dt>Supply now</dt>
              <dd>
                {formatNumber(snapshot.totalMinted)} / {formatNumber(snapshot.maxSupply)}
              </dd>
            </div>
          </dl>

          <div className="row gap-3 wrap">
            {receipt.tokenIds.map((tokenId) => (
              <button key={tokenId} type="button" className="btn btn--ghost btn--sm" onClick={() => savePng(tokenId)}>
                <IconDownload size={15} /> {tokenLabel(tokenId)}
              </button>
            ))}
            <button type="button" className="btn btn--quiet btn--sm" onClick={dismissReceipt}>
              Mint another <IconArrow size={14} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="qty">
            <div className="qty__control">
              <button
                type="button"
                className="qty__btn"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                disabled={effectiveQty <= 1 || minting}
                aria-label="Decrease quantity"
              >
                <IconMinus size={15} />
              </button>
              <span className="qty__value" aria-live="polite">
                {effectiveQty}
              </span>
              <button
                type="button"
                className="qty__btn"
                onClick={() => setQty((q) => Math.min(cap, q + 1))}
                disabled={effectiveQty >= cap || minting}
                aria-label="Increase quantity"
              >
                <IconPlus size={15} />
              </button>
            </div>
            <div className="qty__presets" role="group" aria-label="Quantity presets">
              {Array.from({ length: cap }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  className="preset"
                  aria-pressed={effectiveQty === n}
                  disabled={minting}
                  onClick={() => setQty(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="breakdown">
            <div className="breakdown__row">
              <span>
                Price per field {usingAllowlist ? <b className="chip chip--live" style={{ marginLeft: 6 }}>allowlist</b> : null}
              </span>
              <span>{formatSol(priceSol, 3)} SOL</span>
            </div>
            <div className="breakdown__row">
              <span>Quantity</span>
              <span>× {effectiveQty}</span>
            </div>
            <div className="breakdown__row">
              <span>Accounts + network fees (est.)</span>
              <span>{formatSol(fees, 5)} SOL</span>
            </div>
            <div className="breakdown__row">
              <span>Wallet balance</span>
              <span>{balanceSol === null ? '—' : `${formatSol(balanceSol, 3)} SOL`}</span>
            </div>
            <div className="breakdown__row breakdown__row--total">
              <span>Total</span>
              <span>{formatSol(total, 4)} SOL</span>
            </div>
          </div>

          {phase.requiresAllowlist && !allowlist.included ? (
            <div className="callout" style={{ marginTop: 16 }}>
              <IconShield size={15} />
              <span>
                Allowlist phase. Verify your spot to mint at {MINT_PRICE.allowlistPriceSol} SOL — public minting opens
                later at {MINT_PRICE.publicPriceSol} SOL.
              </span>
            </div>
          ) : null}

          {insufficient && wallet ? (
            <div className="callout callout--error" style={{ marginTop: 16 }}>
              <IconAlert size={15} />
              <span>
                You need about {formatSol(total - (balanceSol ?? 0), 4)} SOL more.{' '}
                {isDemo ? (
                  <button type="button" className="btn btn--quiet btn--sm" onClick={topUpDemo}>
                    Top up demo balance
                  </button>
                ) : (
                  'Fund the wallet and retry.'
                )}
              </span>
            </div>
          ) : null}

          {attempt?.stage === 'error' && attempt.error ? (
            <div className="callout callout--error" style={{ marginTop: 16 }}>
              <IconAlert size={15} />
              <span>
                <b>{attempt.error.message}</b>
                {attempt.error.hint ? <span style={{ display: 'block', opacity: 0.8 }}>{attempt.error.hint}</span> : null}
              </span>
            </div>
          ) : null}

          <div style={{ marginTop: 20 }} className="stack gap-3">
            <button
              type="button"
              className="btn btn--primary btn--lg btn--block"
              disabled={disabled}
              onClick={() => void onPrimary()}
            >
              {minting ? <IconRefresh size={17} className="btn__spin" /> : !wallet ? <IconWallet size={17} /> : <IconBolt size={17} />}
              {cta}
            </button>

            {minting ? (
              <button type="button" className="btn btn--quiet btn--sm btn--block" onClick={cancelMint}>
                Cancel
              </button>
            ) : null}
          </div>

          {attempt && (minting || attempt.stage === 'error') ? <StageStepper stage={attempt.stage} message={attempt.message} progress={attempt.progress} detail={attempt.detail} index={attempt.index} total={attempt.total} /> : null}

          <p className="tiny" style={{ marginTop: 16, fontSize: 11.8, lineHeight: 1.6 }}>
            {isDemo
              ? 'Demo Mode: transactions are simulated locally — no RPC call, no wallet extension and no SOL required. Switch to Live in settings once the program is deployed.'
              : `Live: transactions are signed by your wallet and broadcast to ${network.label} via ${settings.rpcUrl.trim() || network.rpc}.`}
          </p>
        </>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- stepper */

interface StageStepperProps {
  stage: MintStage
  message: string
  progress: number
  detail?: Record<string, string>
  index: number
  total: number
}

function StageStepper({ stage, message, progress, detail, index, total }: StageStepperProps) {
  const isError = stage === 'error' || stage === 'cancelled'
  const currentIndex = STAGE_ORDER.indexOf(stage)

  return (
    <div style={{ marginTop: 22, paddingTop: 20, borderTop: '1px solid var(--line)' }}>
      <div className="spread" style={{ marginBottom: 12 }}>
        <span className="eyebrow">{total > 1 ? `Token ${index} of ${total}` : 'Transaction'}</span>
        <span className="mono tiny">{Math.round(progress * 100)}%</span>
      </div>

      <div className="stepper">
        {STAGE_ORDER.map((s, i) => {
          const done = !isError && currentIndex > i
          const active = !isError && currentIndex === i
          return (
            <div
              key={s}
              className={cn('step', done && 'step--done', active && 'step--active', isError && i === Math.max(currentIndex, 0) && 'step--error')}
            >
              <span className="step__dot">{done ? <IconCheck size={12} /> : i + 1}</span>
              <span>
                <span className="step__name">{STAGE_LABEL[s]}</span>
                {active ? <span className="step__msg">{message}</span> : null}
              </span>
            </div>
          )
        })}
        {isError ? (
          <div className="step step--error">
            <span className="step__dot">
              <IconAlert size={12} />
            </span>
            <span>
              <span className="step__name">{stage === 'cancelled' ? 'Cancelled' : 'Failed'}</span>
              <span className="step__msg">{message}</span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={cn('progress__fill', progress <= 0 && 'progress__fill--indeterminate')}
          style={{ width: `${Math.max(4, progress * 100)}%` }}
        />
      </div>

      {detail && Object.keys(detail).length > 0 ? (
        <dl className="kv" style={{ marginTop: 16 }}>
          {Object.entries(detail).map(([key, value]) => (
            <div className="kv__row" key={key}>
              <dt>{key}</dt>
              <dd style={{ wordBreak: 'break-all' }}>{shortAddress(value, 8, 6)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
