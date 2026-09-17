import { useState } from "react"
import {
  ApiFailure,
  fetchRedroidParams,
  fetchUsableImages,
  formatSize,
  removeImage,
  type CreatedContainer,
  type RedroidImage,
  type RedroidParameter,
} from "./api"
import { CheckCircle, Layers, Plus, Spinner, Trash, X } from "./icons"
import { CreateContainerForm } from "./CreateContainerForm"
import { OfficialImages } from "./OfficialImages"
import {
  Badge,
  Button,
  CommandBlock,
  EmptyState,
  FailureBox,
  IconButton,
  InlineCommand,
  PageHeader,
  TableSkeleton,
} from "./ui"
import { useRemote } from "./useRemote"
import type { Failure } from "./useRemote"

interface ImageRowProps {
  readonly image: RedroidImage
  /** 参数表还没到、或者已经在创建另一个容器的表单时,不让再点"创建容器" */
  readonly createDisabled: boolean
  /** 这一行正在做的事情,没在忙就是 null */
  readonly busyLabel: string | null
  readonly error: Failure | null
  readonly onCreate: () => void
  readonly onRemove: () => void
}

const ImageRow = ({
  image,
  createDisabled,
  busyLabel,
  error,
  onCreate,
  onRemove,
}: ImageRowProps) => {
  const [confirming, setConfirming] = useState(false)
  const busy = busyLabel !== null

  // 删镜像不能撤销。合成出来的镜像代价更高(得重新叠一遍层),所以那句提示
  // 分两种写 —— 原版的下次要重新 pull 就有。
  const confirmText =
    image.kind === "derived"
      ? "删掉这张合成镜像?里面叠的层也一起没"
      : "删掉这张镜像?再要用得重新 pull"

  return (
    <>
      <tr className="border-t border-line transition hover:bg-panel-2/50">
        <td className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* 窄屏上引用名得能在任意位置断行,不然这一列的最小宽度就把
                整个表格顶出去了(表头右侧还有操作按钮) */}
            <span
              className="min-w-0 break-all font-mono text-[13px]"
              title={image.reference}
            >
              {image.reference}
            </span>
            <Badge tone={image.kind === "official" ? "ok" : "info"}>
              {image.kind === "official" ? "原版" : "合成"}
            </Badge>
          </div>
        </td>
        <td className="hidden px-4 py-3 text-muted sm:table-cell">
          {image.architecture}
        </td>
        <td className="px-4 py-3 text-right text-muted tabular-nums whitespace-nowrap">
          {formatSize(image.size)}
        </td>
        <td className="px-4 py-3">
          {busy ? (
            <div className="flex items-center justify-end gap-1.5 text-xs text-muted">
              <Spinner className="size-3.5 animate-spin" />
              <span className="whitespace-nowrap">{busyLabel}</span>
            </div>
          ) : // 确认那一步交给下面单独一行去说 —— 这一格放不下"删了会怎么样"
          // 和两个按钮,窄屏上会被挤成一列一个字。
          confirming ? null : (
            <div className="flex items-center justify-end gap-2">
              <Button
                tone="default"
                size="sm"
                className="border-brand/35 text-brand hover:bg-brand-soft"
                disabled={createDisabled}
                onClick={onCreate}
                title="用这张镜像创建容器"
                aria-label="创建容器"
              >
                <Plus className="size-3.5" />
                {/* 窄屏上光靠图标就够,文字收起来 —— 不然这一列会把表格撑出去 */}
                <span className="hidden sm:inline">创建容器</span>
              </Button>
              <Button
                tone="danger-ghost"
                size="sm"
                onClick={() => setConfirming(true)}
                title="从本机删掉这张镜像"
                aria-label="删除镜像"
              >
                <Trash className="size-3.5" />
                <span className="hidden sm:inline">删除</span>
              </Button>
            </div>
          )}
        </td>
      </tr>
      {confirming && !busy && (
        <tr className="border-t border-line bg-danger-soft/40">
          <td colSpan={4} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 text-xs text-muted">
                {confirmText}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  tone="danger"
                  size="sm"
                  onClick={() => {
                    setConfirming(false)
                    onRemove()
                  }}
                >
                  确定删除
                </Button>
                <Button size="sm" onClick={() => setConfirming(false)}>
                  取消
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
      {error !== null && (
        <tr className="border-t border-line">
          <td colSpan={4} className="px-4 py-3">
            <FailureBox failure={error} />
          </td>
        </tr>
      )}
    </>
  )
}

export const ImagesPanel = () => {
  const { data, failure, busy, reload } = useRemote<ReadonlyArray<RedroidImage>>(
    fetchUsableImages
  )
  // 创建表单是照着官方参数表长出来的,所以这张表也得从后端拿 ——
  // 前端自己写一份的话,两边迟早跑偏。
  const parameters = useRemote<ReadonlyArray<RedroidParameter>>(
    fetchRedroidParams
  )

  const [creating, setCreating] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedContainer | null>(null)
  const [working, setWorking] = useState<{
    readonly reference: string
    readonly label: string
  } | null>(null)
  const [actionError, setActionError] = useState<{
    readonly reference: string
    readonly message: string
    readonly hint: string
  } | null>(null)

  // 删镜像是一次会改本机的动作,所以跟容器那边一样:跑之前先记下"正在忙",
  // 出错了留在那一行上,成功了就重新读一遍列表。
  const remove = async (reference: string) => {
    // 正开着这张镜像的创建表单的话,顺手关掉 —— 镜像待会儿就没了。
    if (creating === reference) setCreating(null)
    setWorking({ reference, label: "删除中…" })
    setActionError(null)
    try {
      await removeImage(reference)
      reload()
    } catch (error) {
      setActionError(
        error instanceof ApiFailure
          ? { reference, message: error.message, hint: error.hint }
          : { reference, message: String(error), hint: "" }
      )
    } finally {
      setWorking(null)
    }
  }

  const selected =
    creating === null
      ? null
      : (data?.find((image) => image.reference === creating) ?? null)

  const count = data?.length ?? 0

  // 后端连不上的时候,镜像表和参数表是一起失败的 —— 同一句话没必要说两遍。
  const failures: ReadonlyArray<Failure> = [failure, parameters.failure]
    .filter((item): item is Failure => item !== null)
    .filter(
      (item, index, all) =>
        all.findIndex(
          (other) => other.message === item.message && other.hint === item.hint
        ) === index
    )

  const reloadAll = () => {
    reload()
    parameters.reload()
  }

  return (
    <>
      <PageHeader
        title="镜像"
        description={
          failure !== null
            ? "读不到镜像列表"
            : data === null
              ? "正在读取本机的 redroid 镜像……"
              : count === 0
                ? "本机没有能用的 redroid 镜像"
                : `${count} 张可以拿来起容器的镜像`
        }
        busy={busy}
        onRefresh={reload}
      />

      {created !== null && (
        <div className="animate-rise mb-4 flex items-start gap-3 rounded-xl border border-ok/30 bg-ok-soft px-4 py-3">
          <CheckCircle className="mt-0.5 size-4 shrink-0 text-ok" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              已创建容器 {created.name}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              连它:
              <InlineCommand
                command={`adb connect localhost:${created.adbPort}`}
              />
            </p>
          </div>
          <IconButton
            onClick={() => setCreated(null)}
            aria-label="关掉这条提示"
          >
            <X className="size-4" />
          </IconButton>
        </div>
      )}

      {failures.length > 0 && (
        <div className="space-y-3">
          {failures.map((item) => (
            <FailureBox
              key={`${item.message}|${item.hint}`}
              failure={item}
              onRetry={reloadAll}
            />
          ))}
        </div>
      )}

      {failure === null && data === null && <TableSkeleton rows={3} />}

      {failure === null && data !== null && count === 0 && (
        <EmptyState
          icon={<Layers className="size-5" />}
          title="没有找到能用的 redroid 镜像"
        >
          <p>下面「官方镜像」里点「拉取」,或者手动拉:</p>
          <CommandBlock command="docker pull redroid/redroid:16.0.0_64only-latest" />
        </EmptyState>
      )}

      {count > 0 && (
        <div className="animate-rise scroll-slim overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-panel-2/60 text-left text-[11px] tracking-wide text-faint">
                <th className="px-4 py-2.5 font-medium">镜像</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">
                  架构
                </th>
                <th className="px-4 py-2.5 text-right font-medium">大小</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data?.map((image) => (
                <ImageRow
                  key={image.reference}
                  image={image}
                  // 参数表还没到就先别开表单 —— 表单是照它生成的。
                  createDisabled={
                    creating !== null || parameters.data === null
                  }
                  busyLabel={
                    working?.reference === image.reference ? working.label : null
                  }
                  error={
                    actionError?.reference === image.reference
                      ? {
                          message: actionError.message,
                          hint: actionError.hint,
                        }
                      : null
                  }
                  onCreate={() => {
                    setCreated(null)
                    setCreating(image.reference)
                  }}
                  onRemove={() => void remove(image.reference)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected !== null && parameters.data !== null && (
        <CreateContainerForm
          image={selected}
          parameters={parameters.data}
          onCreated={(justCreated) => {
            setCreating(null)
            setCreated(justCreated)
            reload()
          }}
          onCancel={() => setCreating(null)}
        />
      )}

      {/* 本机有什么是上面那张表,外面有什么是这里 —— 拉完让上面那张表刷新。 */}
      {/* 本机列表都读不到的时候,这一块只会把同一句错误再说一遍(它也要连
          后端、也要连 Docker),所以干脆不出现。 */}
      {failure === null && (
        <OfficialImages
          local={(data ?? []).map((image) => image.reference)}
          onPulled={reload}
        />
      )}
    </>
  )
}
