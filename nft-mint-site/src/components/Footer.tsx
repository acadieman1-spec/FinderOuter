import { COLLECTION, LINKS, NETWORKS } from '@/config'
import { useApp } from '@/state/AppState'
import { ArtCanvas } from './ArtCanvas'
import { IconExternal } from './Icons'

const COLUMNS: { title: string; links: { label: string; href?: string; action?: string }[] }[] = [
  {
    title: 'Collection',
    links: [
      { label: 'Mint', href: '#mint' },
      { label: 'Library', href: '#collection' },
      { label: 'Rarity', href: '#rarity' },
      { label: 'Roadmap', href: '#roadmap' },
    ],
  },
  {
    title: 'Build',
    links: [
      { label: 'Mint program (Rust)', href: '#provenance' },
      { label: 'How it works', href: '#how' },
      { label: 'FAQ', href: '#faq' },
      { label: 'Settings', action: 'settings' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'X / Twitter', href: LINKS.x },
      { label: 'Discord', href: LINKS.discord },
      { label: 'GitHub', href: LINKS.github },
      { label: 'Magic Eden', href: LINKS.magicEden },
    ],
  },
]

export function Footer({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { settings, snapshot } = useApp()

  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer__word" aria-hidden>
          {COLLECTION.name}
        </div>

        <div className="footer__cols">
          <div>
            <a className="brand" href="#top">
              <span className="brand__mark">
                <ArtCanvas tokenId={42} quality="fast" />
              </span>
              <span>
                {COLLECTION.name}
                <span className="brand__sub">{COLLECTION.symbol} · solana</span>
              </span>
            </a>
            <p className="tiny" style={{ marginTop: 16, maxWidth: '38ch', lineHeight: 1.7, fontSize: 13 }}>
              {COLLECTION.description.slice(0, 168)}…
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h5>{col.title}</h5>
              <ul>
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.action === 'settings' ? (
                      <button type="button" onClick={onOpenSettings}>
                        {link.label}
                      </button>
                    ) : link.href?.startsWith('#') ? (
                      <a href={link.href}>{link.label}</a>
                    ) : (
                      <a href={link.href} target="_blank" rel="noreferrer noopener">
                        {link.label} <IconExternal size={11} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="footer__bottom">
          <span>
            © {new Date().getFullYear()} {COLLECTION.creator} · generator v{COLLECTION.generatorVersion}
          </span>
          <span>
            {settings.mode === 'demo' ? 'DEMO MODE' : NETWORKS[settings.network].label.toUpperCase()} ·{' '}
            {snapshot.totalMinted.toLocaleString('en-US')}/{snapshot.maxSupply.toLocaleString('en-US')} minted
          </span>
          <span>Mint price {COLLECTION.priceSol} SOL · royalty {COLLECTION.royaltyBps / 100}%</span>
        </div>
      </div>
    </footer>
  )
}
