// 界面零件。这里只有"长什么样",不碰接口,也不懂 redroid。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react"
import { Alert, Check, ChevronDown, Copy, Refresh } from "./icons"
import type { Failure } from "./useRemote"

export const cx = (
  ...parts: ReadonlyArray<string | false | null | undefined>
): string => parts.filter(Boolean).join(" ")

/* ------------------------------------------------------------------ 按钮 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: "primary" | "default" | "ghost" | "danger" | "danger-ghost"
  readonly size?: "sm" | "md"
}

const BUTTON_TONES = {
  primary: "bg-brand text-brand-fg hover:opacity-90 shadow-sm",
  default: "border border-line bg-panel text-fg hover:bg-panel-2",
  ghost: "text-muted hover:bg-panel-2 hover:text-fg",
  danger:
    "border border-danger/40 text-danger hover:bg-danger-soft hover:border-danger/60",
  // 破坏性操作,但不想每张卡上都挂一抹红 —— 平时就只是红字。
  "danger-ghost": "text-danger hover:bg-danger-soft",
} as const

export const Button = ({
  tone = "default",
  size = "md",
  className,
  ...rest
}: ButtonProps) => (
  <button
    type="button"
    {...rest}
    className={cx(
      // 按钮里的字不换行:挤到换行看着像坏了,而且高度是定的,换行会溢出。
      "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition disabled:pointer-events-none disabled:opacity-45",
      size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
      BUTTON_TONES[tone],
      className
    )}
  />
)

/** 只有图标的方按钮,记得给它 aria-label。 */
export const IconButton = ({
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    {...rest}
    className={cx(
      "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-panel-2 hover:text-fg disabled:pointer-events-none disabled:opacity-45",
      className
    )}
  />
)

/* ------------------------------------------------------------------ 徽标 */

type BadgeTone = "neutral" | "brand" | "ok" | "warn" | "danger" | "info"

const BADGE_TONES = {
  neutral: "border-line bg-panel-2 text-muted",
  brand: "border-brand/35 bg-brand-soft text-brand",
  ok: "border-ok/35 bg-ok-soft text-ok",
  warn: "border-warn/35 bg-warn-soft text-warn",
  danger: "border-danger/35 bg-danger-soft text-danger",
  info: "border-info/35 bg-info-soft text-info",
} as const

export const Badge = ({
  tone = "neutral",
  pulse = false,
  className,
  children,
}: {
  readonly tone?: BadgeTone
  readonly pulse?: boolean
  readonly className?: string
  readonly children: ReactNode
}) => (
  <span
    className={cx(
      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
      BADGE_TONES[tone],
      className
    )}
  >
    {pulse && (
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
    )}
    {children}
  </span>
)

/* ------------------------------------------------------------- 复制小工具 */

/** 把文字写进本机剪贴板。返回是不是真的写进去了。 */
export const copyText = async (text: string): Promise<boolean> => {
  // 页面可能跑在 http 上(clipboard 只在安全上下文里有),
  // 所以还得留一条老办法兜底。
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 下面再试一次 */
  }
  // 这个临时框会抢走焦点,而控制台是靠 canvas 上的键盘监听吃饭的,复制完
  // 得把焦点还回去,不然用户得再点一下画面键盘才活。
  const previous = document.activeElement
  const area = document.createElement("textarea")
  area.value = text
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.append(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand("copy")
  } catch {
    copied = false
  } finally {
    area.remove()
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
  }
  return copied
}

export const CopyButton = ({
  value,
  label = "复制",
  className,
}: {
  readonly value: string
  readonly label?: string
  readonly className?: string
}) => {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  const run = useCallback(() => {
    void copyText(value).then(() => {
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    })
  }, [value])

  return (
    <button
      type="button"
      onClick={run}
      title={copied ? "复制好了" : `${label}:${value}`}
      aria-label={copied ? "已复制" : label}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-faint transition hover:bg-panel-2 hover:text-fg",
        className
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-ok" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  )
}

/** 行内的一小段命令,带复制按钮。 */
export const InlineCommand = ({
  command,
  className,
}: {
  readonly command: string
  readonly className?: string
}) => (
  <span
    className={cx(
      "inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-panel-2 py-0.5 pr-1 pl-1.5 font-mono text-[12px]",
      className
    )}
  >
    <span className="truncate">{command}</span>
    <CopyButton value={command} label="复制命令" />
  </span>
)

/** 空状态里那种一行命令的展示。 */
export const CommandBlock = ({ command }: { readonly command: string }) => (
  <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-left font-mono text-xs">
    <span className="text-brand select-none">$</span>
    <span className="min-w-0 flex-1 break-words">{command}</span>
    <CopyButton value={command} label="复制命令" />
  </div>
)

/* ------------------------------------------------------------ 页面级组件 */

export const PageHeader = ({
  title,
  description,
  busy = false,
  onRefresh,
  children,
}: {
  readonly title: string
  readonly description?: string
  readonly busy?: boolean
  readonly onRefresh: () => void
  readonly children?: ReactNode
}) => (
  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
    <div className="min-w-0">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description !== undefined && description !== "" && (
        <p className="mt-0.5 text-sm text-muted">{description}</p>
      )}
    </div>
    <div className="flex items-center gap-2">
      {children}
      <Button onClick={onRefresh} disabled={busy}>
        <Refresh className={cx("size-4", busy && "animate-spin")} />
        {busy ? "读取中" : "刷新"}
      </Button>
    </div>
  </div>
)

export const FailureBox = ({
  failure,
  onRetry,
}: {
  readonly failure: Failure
  readonly onRetry?: () => void
}) => (
  <div
    role="alert"
    className="animate-rise flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3.5"
  >
    <Alert className="mt-0.5 size-4 shrink-0 text-danger" />
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-danger">{failure.message}</p>
      {failure.hint !== "" && (
        <p className="mt-0.5 text-sm text-muted">{failure.hint}</p>
      )}
    </div>
    {onRetry !== undefined && (
      <Button size="sm" onClick={onRetry}>
        重试
      </Button>
    )}
  </div>
)

export const EmptyState = ({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly children?: ReactNode
}) => (
  <div className="animate-rise flex flex-col items-center rounded-2xl border border-dashed border-line-strong/70 bg-panel/40 px-6 py-12 text-center">
    <div className="mb-3 flex size-11 items-center justify-center rounded-xl border border-line bg-panel text-faint">
      {icon}
    </div>
    <p className="text-sm font-medium text-fg">{title}</p>
    {children !== undefined && (
      <div className="mt-3 w-full max-w-lg space-y-2 text-sm text-muted">
        {children}
      </div>
    )}
  </div>
)

export const Skeleton = ({ count = 3 }: { readonly count?: number }) => (
  <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
    {Array.from({ length: count }, (_, index) => (
      <div
        key={index}
        className="h-44 animate-pulse rounded-2xl border border-line bg-panel/60"
      />
    ))}
  </div>
)

/* -------------------------------------------------------------- 表单零件 */

/** 输入框、文本域共用的一套皮。 */
const controlBase =
  "w-full rounded-lg border border-line bg-panel text-fg placeholder:text-faint transition outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:opacity-50"

export const controlClass = `${controlBase} px-3 py-2 text-sm`

/** 参数那一堆小格子用的窄版。 */
export const controlCompactClass = `${controlBase} px-2.5 py-1 font-mono text-[12px]`

export const Field = ({
  label,
  hint,
  htmlFor,
  tone = "muted",
  children,
}: {
  readonly label: string
  readonly hint?: ReactNode
  readonly htmlFor?: string
  readonly tone?: "muted" | "warn"
  readonly children: ReactNode
}) => (
  <div>
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
      {label}
    </label>
    {children}
    {hint !== undefined && (
      <p
        className={cx(
          "mt-1.5 text-xs",
          tone === "warn" ? "text-warn" : "text-faint"
        )}
      >
        {hint}
      </p>
    )}
  </div>
)

/** 一整块能点开关的卡片,比原生复选框好点。 */
export const Switch = ({
  checked,
  onChange,
  label,
  description,
}: {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly description?: string
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={cx(
      "flex w-full items-start gap-4 rounded-xl border px-4 py-3 text-left transition",
      checked
        ? "border-brand/45 bg-brand-soft/60"
        : "border-line bg-panel hover:border-line-strong"
    )}
  >
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium">{label}</span>
      {description !== undefined && (
        <span className="mt-0.5 block text-xs text-faint">{description}</span>
      )}
    </span>
    <span
      className={cx(
        "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition",
        checked ? "bg-brand" : "bg-line-strong"
      )}
    >
      <span
        className={cx(
          "size-4 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-4"
        )}
      />
    </span>
  </button>
)

/** 平铺的单选组(几选一,选项很少的时候用)。 */
export const SegmentedGroup = <T extends string>({
  value,
  options,
  onChange,
}: {
  readonly value: T
  readonly options: ReadonlyArray<{
    readonly value: T
    readonly label: string
    readonly hint?: string
  }>
  readonly onChange: (next: T) => void
}) => (
  <div
    className={cx(
      "grid gap-2",
      options.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"
    )}
  >
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}
        className={cx(
          "rounded-xl border px-3 py-2.5 text-left transition",
          value === option.value
            ? "border-brand/50 bg-brand-soft"
            : "border-line bg-panel hover:border-line-strong"
        )}
      >
        <span
          className={cx(
            "block text-sm font-medium",
            value === option.value ? "text-brand" : "text-fg"
          )}
        >
          {option.label}
        </span>
        {option.hint !== undefined && (
          <span className="mt-0.5 block text-xs text-faint">{option.hint}</span>
        )}
      </button>
    ))}
  </div>
)

/** 抽屉/表单里把内容分段的小标题。 */
export const Section = ({
  title,
  description,
  children,
}: {
  readonly title: string
  readonly description?: string
  readonly children: ReactNode
}) => (
  <section className="space-y-3">
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description !== undefined && (
        <p className="mt-0.5 text-xs text-faint">{description}</p>
      )}
    </div>
    {children}
  </section>
)

/** 能折起来的一块内容,默认关着。 */
export const Collapsible = ({
  summary,
  children,
}: {
  readonly summary: ReactNode
  readonly children: ReactNode
}) => (
  <details className="group rounded-xl border border-line bg-panel-2/50">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-muted transition select-none hover:text-fg [&::-webkit-details-marker]:hidden">
      <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      {summary}
    </summary>
    <div className="border-t border-line px-4 py-3">{children}</div>
  </details>
)
