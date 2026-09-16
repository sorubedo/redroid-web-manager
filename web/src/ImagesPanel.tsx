import { useState } from "react"
import {
  fetchRedroidParams,
  fetchUsableImages,
  formatSize,
  type CreatedContainer,
  type RedroidImage,
  type RedroidParameter,
} from "./api"
import { CheckCircle, Layers, Plus, X } from "./icons"
import { CreateContainerForm } from "./CreateContainerForm"
import {
  Badge,
  Button,
  CommandBlock,
  EmptyState,
  FailureBox,
  IconButton,
  InlineCommand,
  PageHeader,
  Skeleton,
} from "./ui"
import { useRemote } from "./useRemote"
import type { Failure } from "./useRemote"

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
              <span>切到「容器」那一页就能管它了。</span>
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

      {failure === null && data === null && <Skeleton count={2} />}

      {failure === null && data !== null && count === 0 && (
        <EmptyState
          icon={<Layers className="size-5" />}
          title="没有找到能用的 redroid 镜像"
        >
          <p>先拉一张官方的:</p>
          <CommandBlock command="docker pull redroid/redroid:14.0.0_64only-latest" />
          <p className="text-xs text-faint">
            标签是 <code>&lt;Android 版本&gt;[_64only]-latest</code>,
            <code>_64only</code> 表示只有 64 位运行库的精简版。
          </p>
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
                <tr
                  key={image.reference}
                  className="border-t border-line transition hover:bg-panel-2/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="font-mono text-[13px]"
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
                  <td className="px-4 py-3 text-right">
                    <Button
                      tone="default"
                      size="sm"
                      className="border-brand/35 text-brand hover:bg-brand-soft"
                      // 参数表还没到就先别开表单 —— 表单是照它生成的。
                      disabled={creating !== null || parameters.data === null}
                      onClick={() => {
                        setCreated(null)
                        setCreating(image.reference)
                      }}
                    >
                      <Plus className="size-3.5" />
                      创建容器
                    </Button>
                  </td>
                </tr>
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
    </>
  )
}
