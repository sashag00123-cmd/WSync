import { Icon, type IconName } from './Icon'

export interface Toast {
  id: number
  level: 'error' | 'warn' | 'ok'
  title: string
  code?: string
  details?: string
}

export interface ToastsProps {
  items: Toast[]
  onDismiss: (id: number) => void
}

const ICONS: Record<Toast['level'], IconName> = {
  error: 'alert',
  warn: 'alert',
  ok: 'check'
}

/**
 * Ошибки показываем всплывающими карточками, а не полосой в потоке страницы:
 * полоса сдвигала содержимое и «съезжала» вверх при прокрутке, тогда как
 * ошибка нужна на виду ровно до того момента, как её прочитали.
 */
export function Toasts(props: ToastsProps): React.JSX.Element | null {
  if (props.items.length === 0) return null
  return (
    <div className="toasts">
      {props.items.map((toast) => (
        <div className={`toast ${toast.level}`} key={toast.id}>
          <Icon name={ICONS[toast.level]} size={19} />
          <div className="body">
            <div className="title">{toast.title}</div>
            {toast.code !== undefined && <div className="code mono">{toast.code}</div>}
            {toast.details !== undefined && (
              <details className="det">
                <summary>Подробности</summary>
                <pre>{toast.details}</pre>
              </details>
            )}
          </div>
          <button
            className="ghost icon-only"
            title="Скрыть"
            onClick={() => props.onDismiss(toast.id)}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
