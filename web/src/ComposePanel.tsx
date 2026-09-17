import { useEffect, useRef, useState } from "react"
import {
  ApiFailure,
  composeImage,
  fetchBaseImages,
  formatSize,
  type ComposeEvent,
  type RedroidImage,
} from "./api"
import { CheckCircle, Layers, Spinner, Terminal, Upload, X } from "./icons"
import { Select } from "./Select"
import {
  Badge,
  Button,
  CommandBlock,
  controlClass,
  EmptyState,
  FailureBox,
  Field,
  IconButton,
  PageHeader,
  Skeleton,
} from "./ui"
import { useRemote } from "./useRemote"

// 输出标签的默认值:在基础镜像的标签后面接 -custom,用户可以改。
// 注意不能和基础镜像完全一样 —— 后端也会拦,这里先给个好默认。
const suggestTarget = (reference: string): string => `${reference}-custom`

const looksLikeError = (line: string): boolean =>
  /error|failed|失败|not found|denied/i.test(line)

/** 同一个文件认出来的样子:同名、同大小、同修改时间就当成同一份。 */
const fileKey = (file: File): string =>
  `${file.name}:${file.size}:${file.lastModified}`

export const ComposePanel = () => {
  const images = useRemote<ReadonlyArray<RedroidImage>>(fetchBaseImages)

  const [base, setBase] = useState("")
  const [target, setTarget] = useState("")
  const [files, setFiles] = useState<ReadonlyArray<File>>([])
  const [lines, setLines] = useState<ReadonlyArray<string>>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [failure, setFailure] = useState<{
    readonly message: string
    readonly hint: string
  } | null>(null)
  const [dropping, setDropping] = useState(false)

  const logRef = useRef<HTMLDivElement>(null)

  // 日志是边跑边冒出来的,新的一来就贴到底部。
  useEffect(() => {
    const element = logRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [lines.length, busy])

  const chooseBase = (reference: string) => {
    setBase(reference)
    setTarget(suggestTarget(reference))
  }

  /**
   * 挑好的 tar 往列表末尾加,而不是换掉 —— 一次挑一个文件是常态,
   * 换掉的话下一次就把上一次挤没了。同一个文件再挑一遍不算数:
   * 层是按顺序叠的,同一份叠两遍基本是挑重了。
   */
  const pickFiles = (picked: ReadonlyArray<File>) => {
    if (picked.length === 0) return
    setFiles((current) => {
      const known = new Set(current.map(fileKey))
      const added = picked.filter((file) => !known.has(fileKey(file)))
      return added.length === 0 ? current : [...current, ...added]
    })
    setResult(null)
  }

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    setResult(null)
    setLines([])

    const form = new FormData()
    // 字段要排在文件前面:后端边收边处理,得先知道 base / target。
    form.append("base", base)
    form.append("target", target)
    for (const file of files) form.append("layers", file, file.name)

    try {
      await composeImage(form, (event: ComposeEvent) => {
        if (event.type === "log") {
          setLines((current) => [...current, event.message ?? ""])
        } else if (event.type === "error") {
          setFailure({
            message: event.message ?? "构建失败",
            hint: event.hint ?? "",
          })
        } else {
          setResult(event.target ?? target)
        }
      })
    } catch (error) {
      setFailure(
        error instanceof ApiFailure
          ? { message: error.message, hint: error.hint }
          : { message: String(error), hint: "" }
      )
    } finally {
      setBusy(false)
    }
  }

  const ready = base !== "" && target !== "" && files.length > 0 && !busy
  const baseImage = images.data?.find((image) => image.reference === base)

  const status = busy
    ? { tone: "info" as const, label: "合成中", pulse: true }
    : failure !== null
      ? { tone: "danger" as const, label: "失败", pulse: false }
      : result !== null
        ? { tone: "ok" as const, label: "完成", pulse: false }
        : { tone: "neutral" as const, label: "待命", pulse: false }

  return (
    <>
      <PageHeader
        title="合成台"
        busy={images.busy}
        onRefresh={images.reload}
      />

      {images.failure !== null && (
        <FailureBox failure={images.failure} onRetry={images.reload} />
      )}

      {images.failure === null && images.data === null && <Skeleton count={2} />}

      {images.failure === null &&
        images.data !== null &&
        images.data.length === 0 && (
          <EmptyState
            icon={<Layers className="size-5" />}
          title="本机没有原版 redroid 镜像"
        >
          <p>先去「镜像」页点「拉取」,或者手动拉:</p>
          <CommandBlock command="docker pull redroid/redroid:16.0.0_64only-latest" />
        </EmptyState>
      )}

      {images.data !== null && images.data.length > 0 && (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="animate-rise space-y-5 rounded-2xl border border-line bg-panel p-5 shadow-sm">
            <Field label="基础镜像" htmlFor="compose-base">
              <Select
                id="compose-base"
                value={base}
                mono
                placeholder="选一张原版镜像…"
                options={images.data.map((image) => ({
                  value: image.reference,
                  label: image.reference,
                  hint: `${image.architecture} · ${formatSize(image.size)}`,
                }))}
                onChange={chooseBase}
              />
            </Field>

            {baseImage !== undefined && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-panel-2/60 px-3 py-2 text-[11px] text-faint">
                <span className="font-mono">{baseImage.architecture}</span>
                <span>{formatSize(baseImage.size)}</span>
                <span className="font-mono">
                  {baseImage.id.replace(/^sha256:/, "").slice(0, 12)}
                </span>
              </div>
            )}

            <Field
              label="输出标签"
              htmlFor="compose-target"
              hint="不能有空格和换行。"
            >
              <input
                id="compose-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                className={`${controlClass} font-mono text-[13px]`}
              />
            </Field>

            <div>
              <span className="mb-1.5 block text-sm font-medium">
                层(tar 包)
              </span>
              <label
                onDragOver={(event) => {
                  event.preventDefault()
                  setDropping(true)
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDropping(false)
                  pickFiles(Array.from(event.dataTransfer.files))
                }}
                className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition ${
                  dropping
                    ? "border-brand bg-brand-soft"
                    : "border-line-strong/70 hover:border-line-strong hover:bg-panel-2/50"
                }`}
              >
                <input
                  type="file"
                  multiple
                  accept=".tar,application/x-tar"
                  className="hidden"
                  onChange={(event) => {
                    pickFiles(Array.from(event.target.files ?? []))
                    // 不清空的话,再挑同一个文件浏览器不会再报一次 change。
                    event.target.value = ""
                  }}
                />
                <Upload className="size-5 text-faint" />
                <span className="text-sm">拖入 tar,或点这里挑文件</span>
              </label>

              {files.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {files.map((file, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center gap-2 rounded-lg border border-line bg-panel-2/50 px-3 py-1.5"
                    >
                      <span className="w-5 shrink-0 text-center text-[11px] text-faint tabular-nums">
                        {index + 1}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-xs"
                        title={file.name}
                      >
                        {file.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-faint tabular-nums">
                        {(file.size / 1024 / 1024).toFixed(1)} MiB
                      </span>
                      <IconButton
                        aria-label={`去掉 ${file.name}`}
                        className="size-6"
                        onClick={() =>
                          setFiles((current) =>
                            current.filter((_, position) => position !== index)
                          )
                        }
                      >
                        <X className="size-3.5" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {result !== null && (
              <div className="animate-rise flex items-start gap-3 rounded-xl border border-ok/30 bg-ok-soft px-4 py-3">
                <CheckCircle className="mt-0.5 size-4 shrink-0 text-ok" />
                <div className="min-w-0 text-sm">
                  <p className="font-medium">合成完成:{result}</p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-line pt-4">
              <Button
                tone="primary"
                disabled={!ready}
                onClick={() => void submit()}
              >
                {busy && <Spinner className="size-4 animate-spin" />}
                {busy ? "合成中…" : "开始合成"}
              </Button>
            </div>
          </div>

          <div className="animate-rise overflow-hidden rounded-2xl border border-line bg-panel shadow-sm lg:sticky lg:top-24">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <Terminal className="size-4 text-faint" />
              <span className="text-sm font-medium">构建日志</span>
              <Badge tone={status.tone} pulse={status.pulse} className="ml-auto">
                {status.label}
              </Badge>
            </div>
            <div
              ref={logRef}
              className="scroll-slim h-96 overflow-y-auto bg-panel-2/40 px-4 py-3 font-mono text-[11.5px] leading-relaxed"
            >
              {lines.length === 0 ? (
                busy && <p className="text-faint">等 Docker 回话…</p>
              ) : (
                lines.map((line, index) => (
                  <p
                    key={index}
                    className={`break-all whitespace-pre-wrap ${
                      looksLikeError(line) ? "text-danger" : "text-muted"
                    }`}
                  >
                    {line}
                  </p>
                ))
              )}
            </div>
            {failure !== null && (
              <div className="border-t border-line p-4">
                <FailureBox failure={failure} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
