/** Inline SVG icon set — no icon dependency, no external requests. */

import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 18, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...props,
  }
}

export const IconWallet = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2" />
    <path d="M3 7.5V17a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-2" />
    <path d="M20 9h-4a3 3 0 0 0 0 6h4a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1Z" />
  </svg>
)

export const IconSettings = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </svg>
)

export const IconClose = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
)

export const IconArrow = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

export const IconCheck = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
)

export const IconCopy = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
  </svg>
)

export const IconExternal = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
  </svg>
)

export const IconRefresh = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 1 0-1.2 5" />
    <path d="M20 5v6h-6" />
  </svg>
)

export const IconSpark = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5 10.2 12.6 4.5 10.8 10.2 9z" />
  </svg>
)

export const IconShield = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3 5 6v6c0 4 3 7.4 7 9 4-1.6 7-5 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
)

export const IconLayers = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </svg>
)

export const IconBolt = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z" />
  </svg>
)

export const IconChevron = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const IconPlus = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconMinus = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
)

export const IconAlert = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 4.5 2.8 20h18.4z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
)

export const IconDownload = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4 19h16" />
  </svg>
)

export const IconEye = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const IconMenu = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
)

/* Wallet marks — abstract geometry, not vendor logos. */
export const WalletGlyph = ({ id, size = 22 }: { id: string; size?: number }) => {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true } as const
  switch (id) {
    case 'phantom':
      return (
        <svg {...common} fill="none">
          <path
            d="M4 13.2c0-4.6 3.6-8.2 8-8.2s8 3.4 8 7.6c0 3.6-2.4 6.4-5.6 6.4h-1.2c-1 0-1.5-.7-1.2-1.5.2-.6.9-1.9 1.2-2.4.3-.5 0-.9-.5-.9H9.6C6.3 14.2 4 16.6 4 13.2Z"
            fill="currentColor"
            opacity=".92"
          />
          <circle cx="9.6" cy="10.4" r="1.15" fill="#0b0812" />
          <circle cx="14" cy="10.4" r="1.15" fill="#0b0812" />
        </svg>
      )
    case 'solflare':
      return (
        <svg {...common} fill="none">
          <path
            d="M12 2.5c1.6 3.2 1.1 5 3.4 6.4 2.3 1.4 4.1.6 5.1 2.3-2.6.6-3.9 2-3.9 4.1 0 3.4-2.6 6.2-6.1 6.2S4.5 18.7 4.5 15.3c0-3.9 3-5.1 3.6-7.6C8.6 5.6 10 4.6 12 2.5Z"
            fill="currentColor"
            opacity=".92"
          />
        </svg>
      )
    case 'backpack':
      return (
        <svg {...common} fill="none">
          <rect x="4.5" y="7" width="15" height="13.5" rx="3.5" fill="currentColor" opacity=".92" />
          <path d="M9 7V5.6A3 3 0 0 1 12 2.6a3 3 0 0 1 3 3V7" stroke="currentColor" strokeWidth="1.8" />
          <rect x="10.4" y="11.5" width="3.2" height="5" rx="1.6" fill="#0b0812" />
        </svg>
      )
    default:
      return (
        <svg {...common} fill="none">
          <path d="M6 3.5h12v17l-6-3.6L6 20.5z" fill="currentColor" opacity=".92" />
          <circle cx="12" cy="9.5" r="2.4" fill="#0b0812" />
        </svg>
      )
  }
}

/** Solana-ish mark for the network pill. */
export const IconSolana = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M5.2 15.4a.8.8 0 0 1 .57-.24h13.6a.4.4 0 0 1 .28.68l-2.5 2.52a.8.8 0 0 1-.57.24H3.05a.4.4 0 0 1-.28-.68z" />
    <path d="M5.2 5.86A.8.8 0 0 1 5.77 5.6h13.6a.4.4 0 0 1 .28.69l-2.5 2.52a.8.8 0 0 1-.57.24H3.05a.4.4 0 0 1-.28-.69z" />
    <path d="M18.17 10.53a.8.8 0 0 1 .57.24l2.5 2.53a.4.4 0 0 1-.28.68H7.33a.8.8 0 0 1-.57-.24l-2.5-2.53a.4.4 0 0 1 .28-.68z" />
  </svg>
)
