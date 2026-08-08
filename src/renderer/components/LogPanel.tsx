import { useState } from 'react'

import type { LogEntry } from '@shared/types'

import { formatTime } from '../lib/format'
import { Icon } from './Icon'

/** Сколько последних записей рисуем. Остальные просто не нужны на экране. */
const VISIBLE = 200

export interface LogPanelProps {
  entries: LogEntry[]
  onClear: () => void
}

/**
 * Журнал живёт в общем потоке страницы и растёт вместе с содержимым — своей
 * полосы прокрутки и фиксированной высоты у него нет: вложенный скролл внутри
 * скроллящейся страницы неудобен, а обрезанный журнал бесполезен.
 */
export function LogPanel(props: LogPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const hidden = Math.max(0, props.entries.length - VISIBLE)
  const shown = props.entries.slice(-VISIBLE)

  return (
    <section className="card">
      <div className="card-head">
        <span className="hicon">
          <Icon name="list" size={17} />
        </span>
        <h2>Журнал операций</h2>
        {props.entries.length > 0 && (
          <span className="sub num" style={{ direction: 'ltr' }}>
            {props.entries.length}
          </span>
        )}
        <span className="grow" />
        <button className="ghost sm" onClick={props.onClear} disabled={props.entries.length === 0}>
          <Icon name="trash" size={15} />
          Очистить
        </button>
        <button
          className="ghost icon-only"
          title={open ? 'Свернуть' : 'Развернуть'}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
        </button>
      </div>

      {open &&
        (props.entries.length === 0 ? (
          <div className="empty-state">
            <div className="ring">
              <Icon name="list" size={22} />
            </div>
            <b>Пока пусто</b>
            <div>Здесь появятся шаги операций, предупреждения и ошибки</div>
          </div>
        ) : (
          <div className="log">
            {hidden > 0 && <div className="log-more">Ранние записи скрыты: {hidden}</div>}
            {shown.map((entry, index) => (
              <div key={`${entry.ts}-${index}`} className={`log-row ${entry.level}`}>
                <span className="time num">{formatTime(entry.ts)}</span>
                <span className="lvl">
                  <Icon
                    name={entry.level === 'error' ? 'close' : entry.level === 'warn' ? 'alert' : 'info'}
                    size={15}
                  />
                </span>
                <span className="msg">
                  {entry.message}
                  {entry.details !== undefined && (
                    <details className="det">
                      <summary>Подробности</summary>
                      <pre>{entry.details}</pre>
                    </details>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))}
    </section>
  )
}
