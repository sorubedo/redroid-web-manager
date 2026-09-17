import {
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  MenuSeparator,
} from "@headlessui/react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  adbConnectHost,
  ApiFailure,
  dataMountLabel,
  fetchContainers,
  isAdbExposed,
  removeContainer,
  startContainer,
  stateLabel,
  stopContainer,
  type ContainerParam,
  type RedroidContainer,
} from "./api"
import {
  Box,
  Check,
  Copy,
  MoreHorizontal,
  Play,
  Screen,
  Sliders,
  Spinner,
  Stop,
  Trash,
  X,
} from "./icons"
import {
  Badge,
  Button,
  CommandBlock,
  CopyButton,
  copyText,
  cx,
  EmptyState,
  FailureBox,
  IconButton,
  PageHeader,
} from "./ui"
import { useRemote } from "./useRemote"

const restartPolicyLabel = (policy: string): string => {
  if (policy === "no") return "不自动重启"
  if (policy === "always") return "总是重启"
  if (policy === "unless-stopped") return "除非手动停止,否则重启"
  if (policy.startsWith("on-failure")) {
    const retries = policy.split(":")[1]
    return retries === undefined ? "失败时重启" : `失败时重启(最多 ${retries} 次)`
  }
  return policy
}

/** 「3 小时前创建」这种。完整时间挂在 title 上,不占卡片的地方。 */
const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return "刚刚创建"
  if (minutes < 60) return `${minutes} 分钟前创建`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前创建`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前创建`
  return `${new Date(iso).toLocaleDateString("zh-CN")} 创建`
}

/** 参数值下面那句解释。官方文档里查不到的,就不硬编一句话了。 */
const explain = (param: ContainerParam): string | null => {
  const parameter = param.parameter
  if (parameter === null) return null
  const parts = [parameter.summary]
  if (parameter.defaultValue !== undefined) {
    parts.push(`默认 ${parameter.defaultValue}`)
  }
  if (parameter.allowedValues !== undefined) {
    parts.push(`可选 ${parameter.allowedValues.join(" / ")}`)
  }
  return parts.join(" · ")
}

const Truth = ({
  label,
  warn = false,
  children,
}: {
  readonly label: string
  readonly warn?: boolean
  readonly children: ReactNode
}) => (
  <div className="min-w-0">
    <dt className="text-[11px] text-faint">{label}</dt>
    <dd
      className={cx(
        // 值可能很长(镜像名、挂载路径……),让它自己换行,不截断。
        "mt-0.5 flex flex-wrap items-start gap-x-1.5 gap-y-0.5 text-[13px] leading-snug",
        warn ? "text-warn" : "text-fg"
      )}
    >
      {children}
    </dd>
  </div>
)

/** 「更多操作」菜单里的一行。 */
const MenuAction = ({
  icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
}) => (
  <MenuItem
    as="button"
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={cx(
      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition select-none",
      "data-disabled:pointer-events-none data-disabled:opacity-40",
      danger
        ? "text-danger data-focus:bg-danger-soft"
        : "text-muted data-focus:bg-panel-2 data-focus:text-fg"
    )}
  >
    <span className="flex size-4 shrink-0 items-center justify-center">
      {icon}
    </span>
    <span className="min-w-0 flex-1 break-words">{label}</span>
  </MenuItem>
)

interface CardProps {
  readonly container: RedroidContainer
  readonly busyLabel: string | null
  readonly error: { readonly message: string; readonly hint: string } | null
  readonly onStart: () => void
  readonly onStop: () => void
  readonly onRemove: () => void
  readonly onOpenScreen: () => void
}

const ContainerCard = ({
  container,
  busyLabel,
  error,
  onStart,
  onStop,
  onRemove,
  onOpenScreen,
}: CardProps) => {
  const [confirming, setConfirming] = useState<"stop" | "remove" | null>(null)
  // 启动参数盖在整张卡片上,而不是把卡片撑高 —— 同排的邻居不会跟着动。
  const [showParams, setShowParams] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const paramsPanel = useRef<HTMLDivElement>(null)

  const busy = busyLabel !== null
  const running = container.state === "running"

  // --rm 的容器,停止就等于删除。这种就不给单独的"删除"了 ——
  // 要么多余,要么会撞上 Docker 自己的清理。
  const stopDeletes = running && container.autoRemove

  const adbAddress =
    container.adbPort === null
      ? null
      : `${container.adbBindAddress ?? "0.0.0.0"}:${container.adbPort}`
  const adbCommand =
    container.adbPort === null
      ? null
      : `adb connect ${adbConnectHost(container.adbBindAddress)}:${container.adbPort}`

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    },
    []
  )

  // 面板打开时按 Esc 关掉。
  useEffect(() => {
    if (!showParams) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowParams(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [showParams])

  // 键盘用户打开面板后,焦点直接落在关闭按钮上(它在面板 DOM 里排第一)。
  useEffect(() => {
    if (!showParams) return
    paramsPanel.current?.querySelector("button")?.focus()
  }, [showParams])

  const flash = (text: string) => {
    setNotice(text)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 1800)
  }

  const copy = (value: string, done: string) => {
    void copyText(value).then((ok) =>
      flash(ok ? done : "复制失败,请手动选中复制")
    )
  }

  const confirmText =
    confirming === "stop"
      ? "这个容器带 --rm,停止之后 Docker 会把它删掉。"
      : container.dataMount === null
        ? "容器会被删除,Android 里的数据跟着一起没。"
        : `容器会被删除,但挂着的 /data(${dataMountLabel(container.dataMount)})会留下。`

  const runConfirmed = () => {
    const action = confirming
    setConfirming(null)
    if (action === "stop") onStop()
    else if (action === "remove") onRemove()
  }

  // 一切正常时不显示这些 —— 一排"已开启"没有信息量,出事才提醒。
  const flags: ReadonlyArray<ReactNode> = [
    container.adbPort === null && (
      <Badge key="adb" tone="warn">
        adb 没映射
      </Badge>
    ),
    !container.privileged && (
      <Badge key="privileged" tone="danger">
        没开特权模式
      </Badge>
    ),
    isAdbExposed(container.adbBindAddress) && (
      <Badge key="adb-bind" tone="danger">
        adb 对全网开放
      </Badge>
    ),
    container.dataMount === null && (
      <Badge key="data" tone="warn">
        数据不持久
      </Badge>
    ),
    container.autoRemove && (
      <Badge key="rm" tone="info">
        --rm 停止即删除
      </Badge>
    ),
  ].filter(Boolean)

  return (
    // overflow-hidden 是给参数面板裁圆角用的;卡片本身高度由内容决定,
    // 面板是 absolute 的,盖上去不会改变卡片占位。
    <article className="animate-rise relative flex flex-col overflow-hidden rounded-2xl border border-line bg-panel p-5 shadow-sm transition hover:border-line-strong">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="font-mono text-sm font-semibold break-all">
            {container.name}
          </h3>
          <p className="mt-1 font-mono text-[11px] break-all text-faint">
            {container.image}
          </p>
        </div>
        <Badge
          tone={
            running ? "ok" : container.state === "created" ? "warn" : "neutral"
          }
          pulse={running}
        >
          {stateLabel(container.state)}
        </Badge>
      </header>

      <dl className="mt-4 grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2">
        <Truth label="adb 端口" warn={container.adbPort === null}>
          {adbAddress === null ? (
            "没映射 5555"
          ) : (
            <>
              <span
                className="min-w-0 font-mono break-all"
                title={adbCommand ?? undefined}
              >
                {adbAddress}
              </span>
              <CopyButton
                value={adbCommand ?? ""}
                label="复制 adb 命令"
              />
            </>
          )}
        </Truth>
        <Truth label="/data 挂载" warn={container.dataMount === null}>
          {container.dataMount === null ? (
            "没挂载"
          ) : (
            <span
              className="min-w-0 break-all"
              title={dataMountLabel(container.dataMount)}
            >
              {dataMountLabel(container.dataMount)}
            </span>
          )}
        </Truth>
        <Truth label="重启策略">
          <span className="min-w-0 break-words">
            {restartPolicyLabel(container.restartPolicy)}
          </span>
        </Truth>
        <Truth label="运行状态">
          <span className="min-w-0 break-words">
            {container.status}
          </span>
        </Truth>
        <Truth label="创建时间">
          <span
            className="min-w-0 break-words"
            title={new Date(container.createdAt).toLocaleString("zh-CN")}
          >
            {relativeTime(container.createdAt)}
          </span>
        </Truth>
      </dl>

      {flags.length > 0 && (
        <div className="mt-3.5 flex flex-wrap gap-1.5">{flags}</div>
      )}

      {error !== null && (
        <div className="mt-3.5">
          <FailureBox failure={error} />
        </div>
      )}

      {/* 启动参数:盖满整张卡片的面板,自己滚动。卡片高度不变,同排的
          卡片也不会被拉伸 —— 「更多操作」里点开。 */}
      {showParams && (
        <div
          ref={paramsPanel}
          role="dialog"
          aria-label={`${container.name} 的启动参数`}
          className="animate-fade absolute inset-0 z-20 flex flex-col rounded-2xl bg-panel"
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Sliders className="size-4 shrink-0 text-faint" />
            <h4 className="min-w-0 flex-1 text-sm font-semibold">启动参数</h4>
            <Badge tone="neutral">{container.params.length} 项</Badge>
            <IconButton
              onClick={() => setShowParams(false)}
              aria-label="关闭启动参数"
            >
              <X className="size-4" />
            </IconButton>
          </div>
          <ul className="scroll-slim flex-1 space-y-2 overflow-y-auto px-4 py-3">
            {container.params.map((param) => {
              const note = explain(param)
              return (
                <li
                  key={param.name}
                  className="rounded-xl border border-line bg-panel-2/40 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 font-mono text-[11px] break-all text-muted">
                      {param.name}
                    </span>
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 font-mono text-[11px] break-all text-brand">
                        {param.value}
                      </span>
                      <CopyButton value={param.value} label="复制参数值" />
                    </span>
                  </div>
                  {note !== null && (
                    <p className="mt-1 text-[11px] break-words text-faint">
                      {note}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <footer className="mt-auto flex min-h-9 flex-wrap items-center gap-2 border-t border-line pt-4">
        {confirming === null ? (
          <>
            {running && container.adbPort !== null && (
              <Button tone="primary" disabled={busy} onClick={onOpenScreen}>
                <Screen className="size-4" />
                看屏幕
              </Button>
            )}
            {running ? (
              <Button
                tone={stopDeletes ? "danger" : "default"}
                disabled={busy}
                onClick={() => (stopDeletes ? setConfirming("stop") : onStop())}
              >
                {busy ? (
                  <Spinner className="size-4 animate-spin" />
                ) : (
                  <Stop className="size-4" />
                )}
                {stopDeletes ? "停止并删除" : "停止"}
              </Button>
            ) : (
              <Button tone="primary" disabled={busy} onClick={onStart}>
                {busy ? (
                  <Spinner className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                启动
              </Button>
            )}

            <div className="ml-auto flex min-w-0 items-center gap-2">
              {busyLabel !== null && (
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-brand">
                  <Spinner className="size-3.5 shrink-0 animate-spin" />
                  <span className="min-w-0 break-words">{busyLabel}</span>
                </span>
              )}
              {busyLabel === null && notice !== null && (
                <span
                  role="status"
                  className="flex min-w-0 items-center gap-1.5 text-[11px] text-ok"
                >
                  <Check className="size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{notice}</span>
                </span>
              )}

              <Menu>
                <MenuButton
                  disabled={busy}
                  className={cx(
                    "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-line bg-panel px-3.5 text-sm font-medium whitespace-nowrap text-fg transition hover:bg-panel-2 disabled:pointer-events-none disabled:opacity-45",
                    "data-open:bg-panel-2"
                  )}
                >
                  <MoreHorizontal className="size-4" />
                  更多操作
                </MenuButton>
                <MenuItems
                  anchor="bottom end"
                  transition
                  modal={false}
                  className={cx(
                    "scroll-slim z-50 max-h-80 w-56 overflow-y-auto rounded-xl border border-line bg-panel p-1 shadow-xl",
                    "[--anchor-gap:6px] [--anchor-padding:10px]",
                    "transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0"
                  )}
                >
                  <MenuAction
                    icon={<Sliders className="size-4" />}
                    label={
                      container.params.length > 0
                        ? `启动参数 · ${container.params.length} 项`
                        : "启动参数 · 无"
                    }
                    disabled={container.params.length === 0}
                    onClick={() => setShowParams(true)}
                  />
                  {adbCommand !== null && (
                    <MenuAction
                      icon={<Copy className="size-4" />}
                      label="复制 adb 命令"
                      onClick={() => copy(adbCommand, "已复制 adb 命令")}
                    />
                  )}
                  <MenuAction
                    icon={<Copy className="size-4" />}
                    label="复制容器 ID"
                    onClick={() => copy(container.id, "已复制容器 ID")}
                  />
                  {!stopDeletes && (
                    <>
                      <MenuSeparator className="my-1 h-px bg-line" />
                      <MenuAction
                        icon={<Trash className="size-4" />}
                        label="删除容器"
                        danger
                        onClick={() => setConfirming("remove")}
                      />
                    </>
                  )}
                </MenuItems>
              </Menu>
            </div>
          </>
        ) : (
          <>
            <p className="min-w-0 flex-1 basis-52 text-xs text-muted">
              {confirmText}
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button tone="danger" size="sm" onClick={runConfirmed}>
                确定
              </Button>
              <Button size="sm" onClick={() => setConfirming(null)}>
                取消
              </Button>
            </div>
          </>
        )}
      </footer>
    </article>
  )
}

/** 读列表时的占位方块。形状照着真卡片来,加载完页面不会跳。 */
const ContainerSkeleton = () => (
  <div className="grid items-start gap-4 lg:grid-cols-2">
    {[0, 1].map((key) => (
      <div
        key={key}
        className="h-72 animate-pulse rounded-2xl border border-line bg-panel/60"
      />
    ))}
  </div>
)

export const ContainersPanel = ({
  onOpenConsole,
}: {
  /** 打开某台容器的控制台。控制台是整页的,所以由上层(App)来切。 */
  readonly onOpenConsole: (container: RedroidContainer) => void
}) => {
  const { data, failure, busy, reload } =
    useRemote<ReadonlyArray<RedroidContainer>>(fetchContainers)

  const [working, setWorking] = useState<{
    readonly id: string
    readonly label: string
  } | null>(null)
  const [actionError, setActionError] = useState<{
    readonly id: string
    readonly message: string
    readonly hint: string
  } | null>(null)

  const act = async (id: string, label: string, run: () => Promise<void>) => {
    setWorking({ id, label })
    setActionError(null)
    try {
      await run()
      reload()
    } catch (error) {
      setActionError(
        error instanceof ApiFailure
          ? { id, message: error.message, hint: error.hint }
          : { id, message: String(error), hint: "" }
      )
    } finally {
      setWorking(null)
    }
  }

  const count = data?.length ?? 0

  return (
    <>
      <PageHeader
        title="容器"
        description={
          failure !== null
            ? "读不到容器列表"
            : data === null
              ? "正在读取本机的 redroid 容器……"
              : count === 0
                ? "本机还没有 redroid 容器"
                : `${count} 台 redroid 容器`
        }
        busy={busy}
        onRefresh={reload}
      />

      {failure !== null && <FailureBox failure={failure} onRetry={reload} />}

      {failure === null && data === null && <ContainerSkeleton />}

      {failure === null && data !== null && count === 0 && (
        <EmptyState
          icon={<Box className="size-5" />}
          title="还没有 redroid 容器"
        >
          <p>去「镜像」页点「创建容器」,或者手动起一台:</p>
          <CommandBlock command="docker run -itd --privileged -p 5555:5555 redroid/redroid:12.0.0_64only-latest" />
        </EmptyState>
      )}

      {count > 0 && (
        // 卡片里东西多,列数宁少勿多:窄屏一列铺满,lg 起两列。
        // items-start 让每张卡片各自撑高,同排的卡片不会被拉长。
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {data?.map((container) => (
            <ContainerCard
              key={container.id}
              container={container}
              busyLabel={working?.id === container.id ? working.label : null}
              error={
                actionError?.id === container.id
                  ? { message: actionError.message, hint: actionError.hint }
                  : null
              }
              onStart={() =>
                void act(container.id, "启动中…", () =>
                  startContainer(container.id)
                )
              }
              onStop={() =>
                void act(container.id, "停止中,最多等 10 秒…", () =>
                  stopContainer(container.id)
                )
              }
              onRemove={() =>
                void act(container.id, "删除中…", () =>
                  removeContainer(container.id)
                )
              }
              onOpenScreen={() => onOpenConsole(container)}
            />
          ))}
        </div>
      )}
    </>
  )
}
