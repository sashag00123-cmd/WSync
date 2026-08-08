import { DOWNLOAD_PHASES, UPLOAD_PHASES, type ProgressEvent } from '@shared/types'

import { formatBytes, formatEta, formatSpeed } from '../lib/format'
import { Icon } from './Icon'

export interface ProgressDockProps {
  event: ProgressEvent
  cancelling: boolean
  onCancel: () => void
}

/**
 * Док внизу окна: фазы, полоса, скорость, остаток. Фазы показаны отдельными
 * шагами, потому что единый процент на многогигабайтной операции не отвечает
 * на главный вопрос — чем программа занята сейчас.
 */
export function ProgressDock(props: ProgressDockProps): React.JSX.Element {
  const { event } = props
  const phases = event.kind === 'upload' ? UPLOAD_PHASES : DOWNLOAD_PHASES
  const percent = event.total > 0 ? Math.min(100, (event.done / event.total) * 100) : null
  const speed = formatSpeed(event.bytesPerSec)
  const eta = formatEta(event.etaSec)

  return (
    <div className="dock">
      <div className="dock-inner">
        <div className="dock-top">
          <div className="dock-title">
            <Icon name={event.kind === 'upload' ? 'upload' : 'download'} size={18} />
            <span>
              {event.kind === 'upload' ? 'Выгрузка' : 'Загрузка'} «{event.world}»
            </span>
          </div>

          <div className="dock-stats">
            {percent === null ? (
              <span className="stat">{event.message ?? 'выполняется'}</span>
            ) : (
              <span className="stat num">
                {percent.toFixed(1)}% · {formatBytes(event.done)} из {formatBytes(event.total)}
              </span>
            )}
            {speed !== '' && (
              <span className="stat num">
                <Icon name="gauge" size={14} />
                {speed}
              </span>
            )}
            {eta !== '' && (
              <span className="stat num">
                <Icon name="clock" size={14} />
                {eta}
              </span>
            )}
          </div>

          <button className="sm" onClick={props.onCancel} disabled={props.cancelling}>
            {props.cancelling ? <Icon name="spinner" size={15} /> : <Icon name="close" size={15} />}
            {props.cancelling ? 'Отменяется' : 'Отменить'}
          </button>
        </div>

        <div className="steps">
          {phases.map((phase, index) => {
            const done = index < event.phaseIndex
            const active = index === event.phaseIndex
            return (
              <div key={phase.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
                {index > 0 && <i className="step-sep" />}
                <span className={`step${done ? ' done' : ''}${active ? ' active' : ''}`}>
                  {done ? (
                    <Icon name="check" size={13} />
                  ) : active ? (
                    <Icon name="spinner" size={13} />
                  ) : null}
                  {phase.label}
                </span>
              </div>
            )
          })}
        </div>

        <div className={`bar${percent === null ? ' indet' : ''}`}>
          <i style={percent === null ? undefined : { width: `${percent}%` }} />
        </div>
      </div>
    </div>
  )
}
