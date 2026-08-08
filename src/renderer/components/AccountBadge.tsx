import type { AuthState, Quota } from '@shared/types'

import { formatBytes } from '../lib/format'
import { Icon } from './Icon'

export interface AccountBadgeProps {
  authState: AuthState
  quota: Quota | null
}

const RING_SIZE = 17
const RING_STROKE = 2.4

/**
 * Индикатор аккаунта в шапке. Намеренно без фона и рамки и ростом с кнопки:
 * прежний «пилюль» с двумя строками и микро-полосой перевешивал всю шапку,
 * а полоса при малом заполнении выглядела случайной точкой.
 *
 * Занятое место показывает кольцо: оно читается на любой доле заполнения.
 */
export function AccountBadge(props: AccountBadgeProps): React.JSX.Element {
  const { authState, quota } = props

  if (!authState.authorized) {
    return (
      <span className="account off" title="Яндекс.Диск не подключён">
        <i className={`state-dot ${authState.needsClientId ? 'warn' : 'danger'}`} />
        <b>{authState.needsClientId ? 'No client_id' : 'Disconnected'}</b>
      </span>
    )
  }

  const usedRatio = quota === null || quota.total === 0 ? null : quota.used / quota.total
  const free = quota === null ? null : quota.total - quota.used
  const tight = usedRatio !== null && usedRatio > 0.9

  // Логина здесь нет намеренно: он показан в настройках, дублировать незачем.
  const title =
    quota === null
      ? 'Сведения о диске недоступны'
      : `Занято ${formatBytes(quota.used)} из ${formatBytes(quota.total)}`

  return (
    <span className="account" title={title}>
      <i className="state-dot ok" />
      <b>Connected</b>
      {free !== null && usedRatio !== null && (
        <span className="quota-part">
          <QuotaRing ratio={usedRatio} tight={tight} />
          <span className={`free num${tight ? ' tight' : ''}`}>{formatBytes(free)}</span>
        </span>
      )}
      {quota === null && (
        <span className="quota-part">
          <Icon name="cloud" size={15} />
        </span>
      )}
    </span>
  )
}

function QuotaRing({ ratio, tight }: { ratio: number; tight: boolean }): React.JSX.Element {
  const radius = (RING_SIZE - RING_STROKE) / 2
  const circumference = 2 * Math.PI * radius
  // Минимальная видимая доля: почти пустой диск иначе рисуется как ничто.
  const filled = Math.max(0.04, Math.min(1, ratio)) * circumference

  return (
    <svg
      className="ring-quota"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        fill="none"
        stroke={tight ? 'var(--warn)' : 'var(--accent)'}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
      />
    </svg>
  )
}
