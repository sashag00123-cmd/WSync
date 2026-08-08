/**
 * Свой набор иконок. Раньше в интерфейсе стояли типографские символы (↑ ↓),
 * которые в каждой ОС рисуются своим шрифтом и выглядят чужеродно. Здесь всё
 * — контурные SVG одной сетки 24×24 с наследованием цвета и толщины линии.
 */

export type IconName =
  | 'upload'
  | 'download'
  | 'refresh'
  | 'settings'
  | 'folder'
  | 'folderOpen'
  | 'check'
  | 'alert'
  | 'info'
  | 'close'
  | 'chevronDown'
  | 'chevronRight'
  | 'cloud'
  | 'cloudOff'
  | 'drive'
  | 'plus'
  | 'search'
  | 'trash'
  | 'external'
  | 'logout'
  | 'gauge'
  | 'clock'
  | 'list'
  | 'world'
  | 'lock'
  | 'spinner'

const PATHS: Record<IconName, React.JSX.Element> = {
  upload: (
    <>
      <path d="M12 16V5" />
      <path d="m8 9 4-4 4 4" />
      <path d="M5 19h14" />
    </>
  ),
  download: (
    <>
      <path d="M12 5v11" />
      <path d="m8 12 4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7.5h8" />
      <path d="M18.5 7.5H20" />
      <circle cx="15.2" cy="7.5" r="2.2" />
      <path d="M4 16.5h4" />
      <path d="M14.8 16.5H20" />
      <circle cx="11.5" cy="16.5" r="2.2" />
    </>
  ),
  folder: (
    <path d="M3 7.5a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.2 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z" />
  ),
  folderOpen: (
    <>
      <path d="M3 8a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.2 1.3H18a2 2 0 0 1 2 2v1" />
      <path d="M3 8v9a2 2 0 0 0 2 2h13.2a1.6 1.6 0 0 0 1.55-1.2L21.4 12H6.6a1.6 1.6 0 0 0-1.55 1.2L3.6 18" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4.5 2.8 19.5h18.4L12 4.5Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.65" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.2V17" />
      <circle cx="12" cy="7.7" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  close: (
    <>
      <path d="m6.5 6.5 11 11" />
      <path d="m17.5 6.5-11 11" />
    </>
  ),
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronRight: <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  cloud: (
    <path d="M7.2 18.5h9.6a3.6 3.6 0 0 0 .5-7.16A5.6 5.6 0 0 0 6.7 10.4a3.98 3.98 0 0 0 .5 8.1Z" />
  ),
  cloudOff: (
    <>
      <path d="M7.2 18.5h9.3a3.6 3.6 0 0 0 1.7-6.8" />
      <path d="M15.6 9.9A5.6 5.6 0 0 0 6.7 10.4a3.98 3.98 0 0 0 .5 8.1" />
      <path d="M4 4l16 16" />
    </>
  ),
  drive: (
    <>
      <rect x="3" y="13" width="18" height="6.5" rx="2" />
      <path d="M5.6 13 8 5.5h8L18.4 13" />
      <circle cx="17" cy="16.2" r="0.85" fill="currentColor" stroke="none" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m19.5 19.5-4.2-4.2" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7.5h16" />
      <path d="M9.5 7.5V5.5h5v2" />
      <path d="M6.5 7.5 7.5 19.5h9l1-12" />
    </>
  ),
  external: (
    <>
      <path d="M14 5h5v5" />
      <path d="M19 5l-7.5 7.5" />
      <path d="M18 14.5V17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.5" />
    </>
  ),
  logout: (
    <>
      <path d="M10 5.5H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      <path d="M9.5 12H19" />
      <path d="m15.5 8.5 3.5 3.5-3.5 3.5" />
    </>
  ),
  gauge: (
    <>
      <path d="M3.8 18a8.5 8.5 0 1 1 16.4 0" />
      <path d="m12 14.5 3.8-4.4" />
      <circle cx="12" cy="15.6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.4 2" />
    </>
  ),
  list: (
    <>
      <path d="M8 7h12" />
      <path d="M8 12h12" />
      <path d="M8 17h12" />
      <circle cx="4.6" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="12" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="17" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  world: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.6 10h16.8" />
      <path d="M3.6 14.5h16.8" />
      <path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.3-3.6-8.5s1.2-6.1 3.6-8.5Z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="8.5" rx="2" />
      <path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11" />
    </>
  ),
  spinner: <circle cx="12" cy="12" r="8.5" strokeDasharray="40 20" />
}

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}

export function Icon({ name, size = 18, className, strokeWidth = 1.7 }: IconProps): React.JSX.Element {
  return (
    <svg
      className={`icon${name === 'spinner' ? ' icon-spin' : ''}${className === undefined ? '' : ` ${className}`}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/** Знак приложения. Облако со стрелками обмена — суть программы одним пятном. */
export function BrandMark({ size = 26 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#wsync-brand)" />
      <path
        d="M11.2 20.4h9.6a3.1 3.1 0 0 0 .45-6.16 4.9 4.9 0 0 0-9.2-.6 3.45 3.45 0 0 0-.85 6.76Z"
        stroke="white"
        strokeOpacity="0.95"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M16 23.6V11.4m-2.4 2.4L16 11.4l2.4 2.4"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient id="wsync-brand" x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5b93ff" />
          <stop offset="1" stopColor="#2f6ae0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
