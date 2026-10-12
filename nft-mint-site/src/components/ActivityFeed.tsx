import { useNow } from '@/hooks'
import { relativeTime, shortAddress } from '@/lib/format'
import { useApp } from '@/state/AppState'

/** Rolling feed of recent mints. */
export function ActivityFeed() {
  const { activity, settings } = useApp()
  const now = useNow(4000)

  return (
    <div className="card card-pad">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Activity</span>
          <div className="h3" style={{ marginTop: 8, fontSize: 22 }}>
            Field log
          </div>
        </div>
        <span className="chip chip--live">
          <span className="pulse-dot" />
          {settings.mode === 'demo' ? 'simulated' : 'live rpc'}
        </span>
      </div>

      <div className="feed">
        {activity.length === 0 ? (
          <p className="feed__empty">
            {settings.mode === 'demo'
              ? 'Waiting for the next mint to land…'
              : 'No recent transactions found for this program.'}
          </p>
        ) : (
          activity.map((entry) => (
            <div className="feed__row" key={entry.id}>
              <span className="feed__who">
                <b>{entry.tokenId ? `#${String(entry.tokenId).padStart(4, '0')}` : 'mint'}</b>{' '}
                {entry.address ? shortAddress(entry.address, 4, 4) : entry.signature ? shortAddress(entry.signature, 6, 4) : 'confirmed'}
              </span>
              <span className="feed__when">{relativeTime(entry.at, now)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
