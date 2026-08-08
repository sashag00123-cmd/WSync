import { useEffect } from 'react'

import { Icon } from './Icon'

export interface ConfirmDialogProps {
  title: string
  lines: string[]
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Подтверждение перезаписи. Формулировки конкретные — «перезапишет прогресс
 * с машины X от такого-то числа» вместо «вы уверены?»: только так у вопроса
 * появляется смысл.
 */
export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element {
  // Esc должен работать: диалог перекрывает всё окно.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onCancel()
      if (event.key === 'Enter') props.onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className="backdrop" onClick={props.onCancel}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <Icon name="alert" size={22} />
          <h3>{props.title}</h3>
        </div>
        <div className="modal-body">
          {props.lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
        <div className="modal-foot">
          <button onClick={props.onCancel}>Отмена</button>
          <button
            className={props.danger === true ? 'primary danger-solid' : 'primary'}
            style={
              props.danger === true
                ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }
                : undefined
            }
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
