// 手写的一小把图标,省掉一个图标库的依赖。
// 统一 24 格视口、用 currentColor 描边,所以大小和颜色都跟着文字走。

import type { ReactNode } from "react"

type IconProps = {
  readonly className?: string
}

const Svg = ({
  className = "size-4",
  children,
}: IconProps & { readonly children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    {children}
  </svg>
)

/** 安卓机器人脑袋,当 logo 用(实心版,不吃 currentColor 的描边)。 */
export const DroidMark = ({ className = "size-5" }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M6.6 3.3a.75.75 0 0 1 1-.25l1.2.7a6.2 6.2 0 0 1 6.4 0l1.2-.7a.75.75 0 1 1 .75 1.3l-.95.55A6.6 6.6 0 0 1 19 10.2v.3H5v-.3a6.6 6.6 0 0 1 2.8-5.3l-.95-.55a.75.75 0 0 1-.25-1.05ZM9.5 7.6a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Zm5 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
    <rect x="4" y="12" width="16" height="7.5" rx="2.4" />
    <rect x="1.6" y="12.6" width="2" height="6" rx="1" />
    <rect x="20.4" y="12.6" width="2" height="6" rx="1" />
  </svg>
)

export const Sun = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </Svg>
)

export const Moon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
  </Svg>
)

export const Refresh = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 11a8 8 0 0 0-13.7-5M4 13a8 8 0 0 0 13.7 5" />
    <path d="M20 4v6h-6M4 20v-6h6" />
  </Svg>
)

export const Play = (props: IconProps) => (
  <Svg {...props}>
    <path d="M7 4.6 19 12 7 19.4V4.6Z" />
  </Svg>
)

export const Stop = (props: IconProps) => (
  <Svg {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2.2" />
  </Svg>
)

export const Trash = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 12.2A1.8 1.8 0 0 0 9.2 21h5.6a1.8 1.8 0 0 0 1.8-1.8L17.5 7M10.5 11v6M13.5 11v6" />
  </Svg>
)

export const Copy = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2.4" />
    <path d="M15 5.4A2.4 2.4 0 0 0 12.6 3H6a2.4 2.4 0 0 0-2.4 2.4V12A2.4 2.4 0 0 0 6 14.4" />
  </Svg>
)

export const Check = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5 13 4.5 4.5L19 6.5" />
  </Svg>
)

export const CheckCircle = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
  </Svg>
)

export const X = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const ChevronDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
)

export const Layers = (props: IconProps) => (
  <Svg {...props}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m4.5 12.5 7.5 4 7.5-4M4.5 16.5l7.5 4 7.5-4" />
  </Svg>
)

export const Box = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20.5 8.2v7.6a1.7 1.7 0 0 1-.9 1.5l-6.8 3.5a1.7 1.7 0 0 1-1.6 0l-6.8-3.5a1.7 1.7 0 0 1-.9-1.5V8.2" />
    <path d="M3.9 7.6 12 3.4l8.1 4.2-8.1 4.2-8.1-4.2ZM12 11.8V21" />
  </Svg>
)

export const Plus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const Alert = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 4.5 21 19.5H3L12 4.5Z" />
    <path d="M12 10v4m0 3v.5" />
  </Svg>
)

export const Terminal = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2.4" />
    <path d="m7.5 10 2.5 2.5-2.5 2.5M12.5 15h4" />
  </Svg>
)

export const Upload = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 15.5V4m0 0L8 8m4-4 4 4" />
    <path d="M4.5 15v3.5A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V15" />
  </Svg>
)

export const Download = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5V15m0 0 4-4m-4 4-4-4" />
    <path d="M4.5 15v3.5A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V15" />
  </Svg>
)

export const Sliders = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 6h14M5 12h14M5 18h14" />
    <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" />
  </Svg>
)

export const Spinner = ({ className = "size-4" }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
    <circle
      cx="12"
      cy="12"
      r="8.5"
      stroke="currentColor"
      strokeOpacity="0.25"
      strokeWidth="2.5"
    />
    <path
      d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
)
