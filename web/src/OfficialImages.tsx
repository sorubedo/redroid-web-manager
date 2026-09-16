import { Fragment, useState } from "react"
import {
  ApiFailure,
  fetchOfficialImages,
  formatSize,
  pullOfficialImage,
  type OfficialImage,
  type PullEvent,
} from "./api"
import { CheckCircle, Download, Refresh, Spinner, X } from "./icons"
import { Badge, Button, cx, FailureBox, IconButton, Skeleton } from "./ui"
import { useRemote } from "./useRemote"

/**
 * Docker Hub 上的官方镜像列表,以及"拉一张下来"。
 *
 * 这一块和本机镜像表是两种东西:本机那半是"我已经有什么",这里的是"外面
 * 有什么、要不要拉"。拉一张要好几分钟,所以拉到一半得把进度摆出来 ——
 * 后端是一层一层推过来的,这里拼成"整条进度 + 每层一行"。
 */

interface LayerProgress {
  readonly status: string
  /** 见过的最大比例,只增不减 —— 下载完转解压时 Docker 会从头报,不看住会往回跳 */
  readonly ratio: number
  readonly current: number
  readonly total: number
}

/** Docker 说的那几种状态,翻成一眼能懂的短词。 */
const statusLabel = (status: string): string => {
  switch (status) {
    case "Pulling fs layer":
      return "准备中"
    case "Waiting":
      return "等待中"
    case "Downloading":
      return "下载中"
    case "Verifying Checksum":
      return "校验中"
    case "Download complete":
      return "下载完成"
    case "Extracting":
      return "解压中"
    case "Pull complete":
      return "完成"
    case "Already exists":
      return "已存在"
    default:
      return status
  }
}

const isFinished = (status: string): boolean =>
  status === "Pull complete" || status === "Already exists"

/** 把一层的新进度并进去。状态、字节数、比例各自该更新就更新。 */
const mergeLayer = (
  layers: ReadonlyMap<string, LayerProgress>,
  event: PullEvent
): ReadonlyMap<string, LayerProgress> => {
  const id = event.id ?? ""
  const previous = layers.get(id)
  const status = event.status ?? previous?.status ?? ""
  const current = event.current ?? 0
  const total = event.total ?? 0
  const observed = total > 0 ? Math.min(1, current / total) : 0

  const next = new Map(layers)
  next.set(id, {
    status,
    // 下载那一段的比例就够了:下载完会转成解压,Docker 从 0 重新报,
    // 直接采信的话整条进度会往回跳。
    ratio: isFinished(status) ? 1 : Math.max(previous?.ratio ?? 0, observed),
    current: current > 0 ? current : (previous?.current ?? 0),
    total: total > 0 ? total : (previous?.total ?? 0),
  })
  return next
}

/** 整条进度:每层各算一份,取平均。层数也是边拉边知道的。 */
const overallRatio = (
  layers: ReadonlyMap<string, LayerProgress>
): number | null => {
  if (layers.size === 0) return null
  let sum = 0
  for (const layer of layers.values()) sum += layer.ratio
  return sum / layers.size
}

const ProgressBar = ({ ratio }: { readonly ratio: number | null }) => (
  <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-strong/50">
    <div
      className={cx(
        "h-full rounded-full bg-brand transition-[width] duration-300",
        // 还没收到任何一层的字节数时,就是个"说不准"的样子
        ratio === null && "w-full animate-pulse bg-brand/40"
      )}
      style={ratio === null ? undefined : { width: `${ratio * 100}%` }}
    />
  </div>
)

const formatDay = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
}

interface OfficialImagesProps {
  /** 本机已经有的引用 —— 已经在的就不给"拉取"按钮了 */
  readonly local: ReadonlyArray<string>
  /** 拉成功之后叫一声,好让本机那张表重新读一遍 */
  readonly onPulled: () => void
}

export const OfficialImages = ({ local, onPulled }: OfficialImagesProps) => {
  const official = useRemote<ReadonlyArray<OfficialImage>>(fetchOfficialImages)

  // 一次只拉一张:同一个 daemon 上并发拉镜像没什么好处,进度也说不清。
  const [pulling, setPulling] = useState<string | null>(null)
  const [layers, setLayers] = useState<ReadonlyMap<string, LayerProgress>>(
    new Map()
  )
  const [activity, setActivity] = useState("")
  const [failure, setFailure] = useState<{
    readonly reference: string
    readonly message: string
    readonly hint: string
  } | null>(null)
  const [pulled, setPulled] = useState<string | null>(null)

  const start = async (reference: string) => {
    setPulling(reference)
    setLayers(new Map())
    setActivity("正在让 Docker 去拉……")
    setFailure(null)
    setPulled(null)

    try {
      await pullOfficialImage(reference, (event) => {
        if (event.type === "layer") {
          setLayers((current) => mergeLayer(current, event))
        } else if (event.type === "log") {
          setActivity(event.message ?? "")
        } else if (event.type === "error") {
          setFailure({
            reference,
            message: event.message ?? "拉取失败",
            hint: event.hint ?? "",
          })
        } else {
          setPulled(event.reference ?? reference)
          onPulled()
        }
      })
    } catch (error) {
      setFailure(
        error instanceof ApiFailure
          ? { reference, message: error.message, hint: error.hint }
          : { reference, message: String(error), hint: "" }
      )
    } finally {
      setPulling(null)
    }
  }

  const images = official.data ?? []
  const ratio = overallRatio(layers)
  const done = [...layers.values()].filter((layer) => isFinished(layer.status))
    .length

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight">官方镜像</h3>
          <p className="mt-0.5 text-sm text-muted">
            Docker Hub 上 redroid/redroid 的官方标签。拉一张到本机,就能拿它起容器。
          </p>
        </div>
        <Button onClick={official.reload} disabled={official.busy}>
          <Refresh className={cx("size-4", official.busy && "animate-spin")} />
          {official.busy ? "读取中" : "刷新"}
        </Button>
      </div>

      {pulled !== null && (
        <div className="animate-rise mb-3 flex items-start gap-3 rounded-xl border border-ok/30 bg-ok-soft px-4 py-3">
          <CheckCircle className="mt-0.5 size-4 shrink-0 text-ok" />
          <p className="min-w-0 flex-1 text-sm">
            已拉取 {pulled},现在可以拿它创建容器了。
          </p>
          <IconButton onClick={() => setPulled(null)} aria-label="关掉这条提示">
            <X className="size-4" />
          </IconButton>
        </div>
      )}

      {official.failure !== null && (
        <FailureBox failure={official.failure} onRetry={official.reload} />
      )}

      {official.failure === null && official.data === null && (
        <Skeleton count={2} />
      )}

      {images.length > 0 && (
        <div className="animate-rise scroll-slim overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-panel-2/60 text-left text-[11px] tracking-wide text-faint">
                <th className="px-4 py-2.5 font-medium">镜像</th>
                <th className="px-4 py-2.5 text-right font-medium">大小</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">
                  更新
                </th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {images.map((image) => {
                const here = local.includes(image.reference)
                const isPulling = pulling === image.reference
                const rowFailure =
                  failure?.reference === image.reference ? failure : null

                return (
                  <Fragment key={image.reference}>
                    <tr className="border-t border-line transition hover:bg-panel-2/50">
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="min-w-0 break-all font-mono text-[13px]"
                            title={image.reference}
                          >
                            {image.reference}
                          </span>
                          {image.only64 && <Badge tone="info">64only</Badge>}
                          {here && <Badge tone="ok">已在本机</Badge>}
                        </div>
                      </td>
                      <td
                        className="px-4 py-3 text-right text-muted tabular-nums whitespace-nowrap"
                        title={image.architectures.join(" / ")}
                      >
                        {formatSize(image.size)}
                      </td>
                      <td className="hidden px-4 py-3 text-muted whitespace-nowrap sm:table-cell">
                        {formatDay(image.updatedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {here ? null : (
                          <Button
                            tone="primary"
                            size="sm"
                            disabled={pulling !== null}
                            onClick={() => void start(image.reference)}
                            aria-label={`拉取 ${image.reference}`}
                          >
                            {isPulling ? (
                              <Spinner className="size-3.5 animate-spin" />
                            ) : (
                              <Download className="size-3.5" />
                            )}
                            {isPulling ? "拉取中" : "拉取"}
                          </Button>
                        )}
                      </td>
                    </tr>
                    {isPulling && (
                      <tr className="border-t border-line bg-brand-soft/40">
                        <td colSpan={4} className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="text-xs font-medium">拉取中</span>
                            <span
                              className="min-w-0 flex-1 truncate text-xs text-muted"
                              title={activity}
                            >
                              {activity}
                            </span>
                            <span className="shrink-0 text-xs text-muted tabular-nums">
                              {done}/{layers.size} 层
                              {ratio !== null && ` · ${Math.round(ratio * 100)}%`}
                            </span>
                          </div>

                          <div className="mt-2">
                            <ProgressBar ratio={ratio} />
                          </div>

                          {layers.size > 0 && (
                            <ul className="scroll-slim mt-2 max-h-36 space-y-1 overflow-y-auto pr-1">
                              {[...layers.entries()].map(([id, layer]) => (
                                <li key={id} className="flex items-center gap-2">
                                  <span
                                    className="w-20 shrink-0 truncate font-mono text-[11px] text-faint"
                                    title={id}
                                  >
                                    {id}
                                  </span>
                                  <span
                                    className={cx(
                                      "w-14 shrink-0 text-[11px]",
                                      isFinished(layer.status)
                                        ? "text-ok"
                                        : "text-muted"
                                    )}
                                  >
                                    {statusLabel(layer.status)}
                                  </span>
                                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line-strong/50">
                                    <span
                                      className={cx(
                                        "block h-full rounded-full",
                                        isFinished(layer.status)
                                          ? "bg-ok"
                                          : "bg-brand"
                                      )}
                                      style={{ width: `${layer.ratio * 100}%` }}
                                    />
                                  </span>
                                  <span className="w-28 shrink-0 text-right text-[11px] text-faint tabular-nums">
                                    {layer.total > 0
                                      ? `${formatSize(layer.current)} / ${formatSize(layer.total)}`
                                      : ""}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                    {rowFailure !== null && (
                      <tr className="border-t border-line">
                        <td colSpan={4} className="px-4 py-3">
                          <FailureBox failure={rowFailure} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
