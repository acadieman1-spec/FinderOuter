import { useEffect, useState } from 'react'
import { COLLECTION, NETWORKS } from '@/config'
import { formatSol, shortAddress } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useApp } from '@/state/AppState'
import { ArtCanvas } from './ArtCanvas'
import { IconSettings, IconSolana, IconWallet } from './Icons'
import { WalletGlyph } from './Icons'

const LINKS = [
  { href: '#collection', label: 'Collection' },
  { href: '#mint', label: 'Mint' },
  { href: '#rarity', label: 'Rarity' },
  { href: '#how', label: 'How it works' },
  { href: '#roadmap', label: 'Roadmap' },
]

interface NavProps {
  onOpenWallet: () => void
  onOpenSettings: () => void
}

export function Nav({ onOpenWallet, onOpenSettings }: NavProps) {
  const { wallet, balanceSol, settings, phase } = useApp()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const network = NETWORKS[settings.network]
  const isMain = settings.network === 'mainnet-beta'

  return (
    <header className={cn('nav', scrolled && 'nav--scrolled')}>
      <div className="shell nav__inner">
        <a className="brand" href="#top" aria-label={`${COLLECTION.name} home`}>
          <span className="brand__mark">
            <ArtCanvas tokenId={1} quality="fast" />
          </span>
          <span>
            {COLLECTION.name}
            <span className="brand__sub">generative fields</span>
          </span>
        </a>

        <nav className="nav__links" aria-label="Sections">
          {LINKS.map((link) => (
            <a key={link.href} className="nav__link" href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <span className="nav__spacer" />

        <span
          className={cn('net-pill hide-sm', isMain && 'net-pill--main')}
          title={settings.mode === 'live' ? network.rpc : 'Demo mode — no RPC calls'}
        >
          <IconSolana size={14} />
          {settings.mode === 'demo' ? 'DEMO' : network.short}
        </span>

        <div className="nav__actions">
          <button
            type="button"
            className="btn btn--ghost btn--icon hide-sm"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
          >
            <IconSettings size={17} />
          </button>

          {wallet ? (
            <button type="button" className="wallet-chip" onClick={onOpenWallet} aria-label="Wallet details">
              <span className="wallet-chip__dot">
                <WalletGlyph id={wallet.id} size={16} />
              </span>
              <span className="wallet-chip__meta">
                <span className="wallet-chip__addr">{shortAddress(wallet.address)}</span>
                <span className="wallet-chip__bal">
                  {balanceSol === null ? '—' : `${formatSol(balanceSol, wallet.isDemo ? 2 : 3)} SOL`}
                </span>
              </span>
            </button>
          ) : (
            <button type="button" className="btn btn--primary btn--sm" onClick={onOpenWallet}>
              <IconWallet size={16} />
              Connect
            </button>
          )}

          <span
            className={cn('chip hide-sm', phase.status === 'live' ? 'chip--live' : 'chip--demo')}
            style={{ marginLeft: 2 }}
          >
            <span className={cn('pulse-dot', phase.status !== 'live' && 'pulse-dot--idle')} />
            {phase.status === 'live' ? phase.label : phase.status === 'soldout' ? 'Sold out' : phase.label}
          </span>
        </div>
      </div>
    </header>
  )
}
