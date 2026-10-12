import { useCountdown } from '@/hooks'

interface CountdownProps {
  target: number
  /** Shown instead of the clock when there is nothing to count down to. */
  endedLabel?: string
}

const CELLS = [
  { key: 'days', label: 'days' },
  { key: 'hours', label: 'hrs' },
  { key: 'minutes', label: 'min' },
  { key: 'seconds', label: 'sec' },
] as const

export function Countdown({ target, endedLabel = 'Live now' }: CountdownProps) {
  const left = useCountdown(target)

  if (left.total <= 0) {
    return (
      <div className="countdown" aria-live="off">
        <div className="countdown__cell" style={{ gridColumn: '1 / -1' }}>
          <span className="countdown__value" style={{ fontSize: 'clamp(20px,3vw,30px)' }}>
            {endedLabel}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="countdown" role="timer" aria-label="Time remaining">
      {CELLS.map((cell) => (
        <div className="countdown__cell" key={cell.key}>
          <span className="countdown__value">{String(left[cell.key]).padStart(2, '0')}</span>
          <span className="countdown__label">{cell.label}</span>
        </div>
      ))}
    </div>
  )
}
