import type { WorldRow } from '@shared/types'

import { formatBytes, formatDate, relativeDays, statusView } from '../lib/format'
import { Icon } from './Icon'

export interface WorldListProps {
  rows: WorldRow[]
  sizes: Record<string, number>
  busyWorld: string | null
  busy: boolean
  authorized: boolean
  onUpload: (world: string) => void
  onDownload: (world: string) => void
}

/**
 * Локальные и облачные миры в одном списке. Действия подписаны словами:
 * стрелка без подписи не говорит, куда именно поедут гигабайты, а ошибка
 * направления здесь дорого стоит.
 */
export function WorldList(props: WorldListProps): React.JSX.Element {
  if (props.rows.length === 0) {
    return (
      <div className="empty-state">
        <div className="ring">
          <Icon name="world" size={24} />
        </div>
        <b>Миров не найдено</b>
        <div>В каталоге saves нет папок с файлом level.dat</div>
      </div>
    )
  }

  return (
    <div>
      <div className="wl-head">
        <div>Мир</div>
        <div>Локально</div>
        <div>В облаке</div>
        <div>Статус</div>
        <div style={{ textAlign: 'right' }}>Действия</div>
      </div>

      {props.rows.map((row) => {
        const status = statusView(row.status)
        const size = props.sizes[row.name] ?? row.local?.sizeBytes ?? null
        const blocked = props.busy || row.inUse
        const active = props.busyWorld === row.name
        const showLocalSkeleton = row.local !== null && size === null

        return (
          <div className={`wl-row${active ? ' busy' : ''}`} key={row.name}>
            <div className="wl-name">
              <span className="glyph">
                <Icon name={active ? 'spinner' : 'world'} size={19} />
              </span>
              <div className="text">
                <b title={row.name}>{row.name}</b>
                {row.inUse ? (
                  <span className="tag">
                    <Icon name="lock" size={13} /> открыт в игре
                  </span>
                ) : row.inUseUnknown ? (
                  <span className="tag">
                    <Icon name="alert" size={13} /> не проверить, запущена ли игра
                  </span>
                ) : row.local?.levelName != null && row.local.levelName !== row.name ? (
                  <div className="meta">в игре: {row.local.levelName}</div>
                ) : null}
              </div>
            </div>

            <div className={`wl-local${row.local === null ? ' empty' : ''}`}>
              {row.local === null ? (
                <span className="dash">—</span>
              ) : (
                <>
                  <div className="size num">
                    {showLocalSkeleton ? <span className="skeleton" /> : formatBytes(size)}
                  </div>
                  <div className="when" title={formatDate(row.local.lastPlayed)}>
                    {relativeDays(row.local.lastPlayed) || formatDate(row.local.lastPlayed)}
                  </div>
                </>
              )}
            </div>

            <div className={`wl-cloud${row.cloud === null ? ' empty' : ''}`}>
              {row.cloud === null ? (
                <span className="dash">—</span>
              ) : (
                <>
                  <div className="size num">{formatBytes(row.cloud.archiveSize)}</div>
                  <div className="when" title={`Выгружено ${formatDate(row.cloud.uploadedAt)}`}>
                    {relativeDays(row.cloud.lastPlayed) || formatDate(row.cloud.lastPlayed)} ·{' '}
                    {row.cloud.uploadedBy}
                  </div>
                </>
              )}
            </div>

            <div className="wl-status">
              <span className={`pill ${status.tone}`} title={status.hint}>
                <i className="dot" />
                {status.label}
              </span>
            </div>

            <div className="wl-actions">
              <button
                className="sm"
                title={
                  row.local === null
                    ? 'Нет локальной копии'
                    : row.inUse
                      ? 'Мир открыт запущенной игрой'
                      : `Выгрузить «${row.name}» в облако`
                }
                disabled={blocked || row.local === null || !props.authorized}
                onClick={() => props.onUpload(row.name)}
              >
                <Icon name="upload" size={16} />
                В облако
              </button>
              <button
                className="sm"
                title={
                  row.cloud === null
                    ? 'В облаке нет этого мира'
                    : row.inUse
                      ? 'Мир открыт запущенной игрой'
                      : `Загрузить «${row.name}» на этот ПК`
                }
                disabled={blocked || row.cloud === null || !props.authorized}
                onClick={() => props.onDownload(row.name)}
              >
                <Icon name="download" size={16} />
                На ПК
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
