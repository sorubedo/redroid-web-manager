import { useState, type ReactNode } from "react"
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
import { DevicePanel } from "./DevicePanel"
import { Box, Play, Screen, Spinner, Stop, Trash } from "./icons"
import {
  Badge,
  Button,
  Collapsible,
  CommandBlock,
  CopyButton,
  cx,
  EmptyState,
  FailureBox,
  PageHeader,
  Skeleton,
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
        "mt-0.5 flex items-center gap-1 text-[13px]",
        warn ? "text-warn" : "text-fg"
      )}
    >
      {children}
    </dd>
  </div>
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
  const busy = busyLabel !== null
  const running = container.state === "running"

  // --rm 的容器,停止就等于删除。这种就不给单独的"删除"按钮了 ——
  // 要么多余,要么会撞上 Docker 自己的清理。
  const stopDeletes = running && container.autoRemove

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
    <article className="animate-rise flex flex-col rounded-2xl border border-line bg-panel p-5 shadow-sm transition hover:border-line-strong">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            className="truncate font-mono text-sm font-semibold"
            title={container.name}
          >
            {container.name}
          </h3>
          <p
            className="mt-1 truncate font-mono text-[11px] text-faint"
            title={container.image}
          >
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

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Truth label="adb 端口" warn={container.adbPort === null}>
          {container.adbPort === null ? (
            "没映射 5555"
          ) : (
            <>
              <span
                className="truncate font-mono"
                title={`${adbConnectHost(
                  container.adbBindAddress
                )}:${container.adbPort}`}
              >
                {container.adbBindAddress ?? "0.0.0.0"}:{container.adbPort}
              </span>
              <CopyButton
                value={`adb connect ${adbConnectHost(
                  container.adbBindAddress
                )}:${container.adbPort}`}
                label="复制 adb 命令"
              />
            </>
          )}
        </Truth>
        <Truth label="/data 挂载" warn={container.dataMount === null}>
          {container.dataMount === null ? (
            "没挂载"
          ) : (
            <span className="truncate" title={dataMountLabel(container.dataMount)}>
              {dataMountLabel(container.dataMount)}
            </span>
          )}
        </Truth>
        <Truth label="重启策略">
          <span className="truncate">
            {restartPolicyLabel(container.restartPolicy)}
          </span>
        </Truth>
        <Truth label="运行状态">
          <span className="truncate" title={container.status}>
            {container.status}
          </span>
        </Truth>
      </dl>

      {flags.length > 0 && (
        <div className="mt-3.5 flex flex-wrap gap-1.5">{flags}</div>
      )}

      {container.params.length > 0 && (
        <div className="mt-3.5">
          <Collapsible summary={`启动参数 · ${container.params.length} 项`}>
            <ul className="scroll-slim max-h-56 space-y-2 overflow-y-auto pr-1">
              {container.params.map((param) => {
                const note = explain(param)
                return (
                  <li key={param.name}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className="truncate font-mono text-[11px] text-muted"
                        title={param.name}
                      >
                        {param.name}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-brand">
                        {param.value}
                      </span>
                    </div>
                    {note !== null && (
                      <p className="mt-0.5 text-[11px] text-faint">{note}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          </Collapsible>
        </div>
      )}

      {error !== null && (
        <div className="mt-3.5">
          <FailureBox failure={error} />
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-line pt-4">
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
            {!stopDeletes && (
              <Button
                tone="danger-ghost"
                disabled={busy}
                onClick={() => setConfirming("remove")}
              >
                <Trash className="size-4" />
                删除
              </Button>
            )}
            <span
              className="ml-auto truncate text-[11px] text-faint"
              title={new Date(container.createdAt).toLocaleString("zh-CN")}
            >
              {busyLabel ?? relativeTime(container.createdAt)}
            </span>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-xs text-muted">
              {confirmText}
            </span>
            <Button tone="danger" size="sm" onClick={runConfirmed}>
              确定
            </Button>
            <Button size="sm" onClick={() => setConfirming(null)}>
              取消
            </Button>
          </>
        )}
      </div>
    </article>
  )
}

export const ContainersPanel = () => {
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

  // 打开设备视图的那台容器。同时只开一台 —— adbd 同时只认一个客户端,
  // 开一堆只会互相挤。
  const [opened, setOpened] = useState<RedroidContainer | null>(null)

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

      {failure === null && data === null && <Skeleton />}

      {failure === null && data !== null && count === 0 && (
        <EmptyState
          icon={<Box className="size-5" />}
          title="还没有 redroid 容器"
        >
          <p>去「镜像」那一页挑一张镜像点「创建容器」,或者手动起一台:</p>
          <CommandBlock command="docker run -itd --privileged -p 5555:5555 redroid/redroid:12.0.0_64only-latest" />
        </EmptyState>
      )}

      {count > 0 && (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
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
              onOpenScreen={() => setOpened(container)}
            />
          ))}
        </div>
      )}

      {opened !== null && (
        <DevicePanel container={opened} onClose={() => setOpened(null)} />
      )}
    </>
  )
}
