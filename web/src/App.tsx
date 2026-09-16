import { lazy, Suspense, useState, type ReactElement } from "react"
import type { RedroidContainer } from "./api"
import { ComposePanel } from "./ComposePanel"
import { ContainersPanel } from "./ContainersPanel"
import { ImagesPanel } from "./ImagesPanel"
import { Box, DroidMark, Layers, Moon, Sun, Terminal } from "./icons"
import { useTheme } from "./theme"
import { cx, IconButton } from "./ui"

// 控制台里装着 Tango 的 ADB 和 scrcpy 那一整套(解码器、WebCodecs 封装),
// 体积比管理台本身还大,而只有点「看屏幕」才用得到 —— 所以让它按需加载,
// 首屏不背这个包袱。
const DeviceConsole = lazy(async () => {
  const module = await import("./DeviceConsole")
  return { default: module.DeviceConsole }
})

type Tab = "containers" | "images" | "compose"

const TABS: ReadonlyArray<{
  readonly id: Tab
  readonly label: string
  readonly icon: (props: { readonly className?: string }) => ReactElement
}> = [
  { id: "containers", label: "容器", icon: Box },
  { id: "images", label: "镜像", icon: Layers },
  { id: "compose", label: "合成台", icon: Terminal },
]

const Brand = () => (
  <div className="flex min-w-0 items-center gap-2.5">
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-info text-brand-fg shadow-sm">
      <DroidMark className="size-5" />
    </span>
    <span className="min-w-0">
      <span className="block truncate text-sm leading-tight font-semibold tracking-tight">
        redroid
      </span>
      <span className="block truncate text-[11px] leading-tight text-faint">
        本机容器管理台
      </span>
    </span>
  </div>
)

const Tabs = ({
  tab,
  onSelect,
  compact = false,
}: {
  readonly tab: Tab
  readonly onSelect: (next: Tab) => void
  readonly compact?: boolean
}) => (
  <nav
    aria-label="页面"
    className={cx(
      "flex items-center gap-1 rounded-full border border-line bg-panel-2/80 p-1",
      compact && "w-full"
    )}
  >
    {TABS.map((item) => {
      const Icon = item.icon
      const active = item.id === tab
      return (
        <button
          key={item.id}
          type="button"
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(item.id)}
          className={cx(
            "inline-flex items-center justify-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition",
            compact && "flex-1",
            active
              ? "bg-panel text-fg shadow-sm ring-1 ring-line"
              : "text-muted hover:text-fg"
          )}
        >
          <Icon className="size-4" />
          {item.label}
        </button>
      )
    })}
  </nav>
)

export const App = () => {
  const [tab, setTab] = useState<Tab>("containers")
  // 控制台是整页的:开着的时候把管理台整个换掉,不是盖一层弹窗。
  // 同时只开一台 —— adbd 同时只认一个客户端,开一堆只会互相挤。
  const [console, setConsole] = useState<RedroidContainer | null>(null)
  const { theme, toggle } = useTheme()

  if (console !== null) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-dvh items-center justify-center text-sm text-muted">
            正在加载控制台……
          </div>
        }
      >
        <DeviceConsole container={console} onClose={() => setConsole(null)} />
      </Suspense>
    )
  }

  return (
    <div className="relative flex min-h-dvh flex-col">
      {/* 顶上那层很淡的光,暗色下页面不至于死平 */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(60rem_30rem_at_50%_-14rem,var(--glow),transparent)]"
      />

      <header className="sticky top-0 z-30 border-b border-line/70 bg-app/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Brand />
          <div className="ml-auto hidden sm:block">
            <Tabs tab={tab} onSelect={setTab} />
          </div>
          <IconButton
            onClick={toggle}
            title={theme === "dark" ? "切到亮色" : "切到暗色"}
            aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
            className="border border-line bg-panel text-fg"
          >
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </IconButton>
        </div>
        <div className="border-t border-line/60 px-4 py-2 sm:hidden">
          <Tabs tab={tab} onSelect={setTab} compact />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {tab === "containers" && (
          <ContainersPanel onOpenConsole={setConsole} />
        )}
        {tab === "images" && <ImagesPanel />}
        {tab === "compose" && <ComposePanel />}
      </main>
    </div>
  )
}
