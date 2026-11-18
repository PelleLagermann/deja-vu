import type { ReactNode } from 'react';

const PATHS = {
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M5 3.5v9M11 3.5v9" strokeWidth="2.4" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
  step: (
    <>
      <path d="M3.5 3.5v9l6.5-4.5z" fill="currentColor" stroke="none" />
      <path d="M12 3.5v9" strokeWidth="2" />
    </>
  ),
  restart: (
    <>
      <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" />
      <path d="M3 2.6v2.6h2.6" />
    </>
  ),
  record: <circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none" />,
  chevronRight: <path d="M6 3.5 10.5 8 6 12.5" />,
  chevronLeft: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  chevronDown: <path d="M3.5 6 8 10.5 12.5 6" />,
  chevronUp: <path d="M3.5 10 8 5.5 12.5 10" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="m10 10 3.2 3.2" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2" />
      <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />
    </>
  ),
  upload: <path d="M8 10.5V3M5 5.8 8 3l3 2.8M3 10v3h10v-3" />,
  download: <path d="M8 3v7.5M5 7.8l3 2.7 3-2.7M3 10v3h10v-3" />,
  folder: <path d="M2.5 4.5a1 1 0 0 1 1-1h2.8l1.4 1.6h4.8a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  settings: <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M9.5 3v3M5.5 10v3" />,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.7M2.5 8h.7M2.5 12h.7" />,
  target: (
    <>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  alert: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2v.1" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  cursor: <path d="m4 3 8.5 4-3.6 1.3L7.6 12z" />,
  keyboard: (
    <>
      <rect x="1.8" y="4" width="12.4" height="8" rx="1.2" />
      <path d="M4.5 6.8h.1M7 6.8h.1M9.5 6.8h.1M12 6.8h.1M5.5 9.5h5" />
    </>
  ),
  text: <path d="M3.5 4.5V3h9v1.5M8 3v10M6.2 13h3.6" />,
  globe: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.4 8h11.2M8 2.4c-3.2 3.4-3.2 7.8 0 11.2M8 2.4c3.2 3.4 3.2 7.8 0 11.2" />
    </>
  ),
  link: <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />,
  shield: <path d="M8 2 3 3.8v4c0 3 2.1 5 5 6.2 2.9-1.2 5-3.2 5-6.2v-4z" />,
  checkSquare: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="m5 8.2 2.2 2.2L11 5.8" />
    </>
  ),
  chooser: (
    <>
      <rect x="2" y="4" width="12" height="8" rx="1.2" />
      <path d="m9.5 7 1.5 1.8L12.5 7" />
    </>
  ),
  scroll: <path d="M8 2.5v11M5.2 5 8 2.5 10.8 5M5.2 11 8 13.5 10.8 11" />,
  move: <path d="M8 2v12M2 8h12M6 4l2-2 2 2M6 12l2 2 2-2M4 6 2 8l2 2M12 6l2 2-2 2" />,
  dialog: <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />,
  hand: <path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7.2V4.2a1 1 0 0 1 2 0v5.2c0 2.6-1.4 4.1-3.8 4.1-2 0-2.9-1-3.7-2.5L2.8 8.8a1 1 0 0 1 1.7-1z" />,
  repeat: <path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2" />,
  file: <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />,
  group: <path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M11 2.5h1.5a1 1 0 0 1 1 1V5M13.5 11v1.5a1 1 0 0 1-1 1H11M5 13.5H3.5a1 1 0 0 1-1-1V11M5.5 6.5h5M5.5 9.5h5" />,
  variable: <path d="M6 2.5c-1.5 0-2 .8-2 2V6c0 .9-.5 1.6-1.5 2 1 .4 1.5 1.1 1.5 2v1.5c0 1.2.5 2 2 2M10 2.5c1.5 0 2 .8 2 2V6c0 .9.5 1.6 1.5 2-1 .4-1.5 1.1-1.5 2v1.5c0 1.2-.5 2-2 2" />,
  range: <path d="M2.5 3v10M13.5 3v10M5 8h6M6.5 6 4.8 8l1.7 2M9.5 6l1.7 2-1.7 2" />,
  cookie: (
    <>
      <path d="M13.5 8.3A5.5 5.5 0 1 1 7.7 2.5a2 2 0 0 0 2.4 2.4 2 2 0 0 0 3.4 3.4z" />
      <path d="M5.6 6.4h.1M6.4 10.4h.1M9.6 9.6h.1" strokeWidth="2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
