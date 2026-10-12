import { useApp } from '@/state/AppState'
import { cn } from '@/lib/cn'
import { IconAlert, IconCheck, IconClose, IconSpark } from './Icons'

export function Toasts() {
  const { toasts, dismissToast } = useApp()
  if (toasts.length === 0) return null

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn('toast', `toast--${toast.tone}`)}>
          <span className="toast__icon">
            {toast.tone === 'success' ? (
              <IconCheck size={15} />
            ) : toast.tone === 'error' ? (
              <IconAlert size={15} />
            ) : (
              <IconSpark size={15} />
            )}
          </span>
          <div>
            <div className="toast__title">{toast.title}</div>
            {toast.body ? <div className="toast__body">{toast.body}</div> : null}
          </div>
          <button
            type="button"
            className="btn btn--quiet btn--icon"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
          >
            <IconClose size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
