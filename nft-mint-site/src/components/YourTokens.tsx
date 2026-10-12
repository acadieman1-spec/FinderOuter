import { useApp } from '@/state/AppState'
import { ArtCanvas } from './ArtCanvas'
import { IconArrow } from './Icons'

/** Tokens owned in this browser (demo wallet holdings or session mints). */
export function YourTokens({ onMint }: { onMint: () => void }) {
  const { myTokens } = useApp()

  return (
    <div className="card card-pad">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Your fields</span>
          <div className="h3" style={{ marginTop: 8, fontSize: 22 }}>
            {myTokens.length === 0 ? 'Nothing minted yet' : `${myTokens.length} in this wallet`}
          </div>
        </div>
      </div>

      {myTokens.length === 0 ? (
        <div className="stack gap-3">
          <p className="tiny" style={{ fontSize: 13, lineHeight: 1.65 }}>
            Mint a field and it appears here — rendered locally from the token seed you just claimed, exactly as it will
            render for anyone who verifies it later.
          </p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onMint}>
            Go to the mint panel <IconArrow size={15} />
          </button>
        </div>
      ) : (
        <div className="receipt__art">
          {myTokens.map((tokenId) => (
            <figure key={tokenId}>
              <ArtCanvas tokenId={tokenId} quality="fast" />
              <figcaption>#{String(tokenId).padStart(4, '0')}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  )
}
