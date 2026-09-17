import { useEffect, useState } from "react"
import {
  ApiFailure,
  createContainer,
  formatSize,
  type CreateContainerInput,
  type CreatedContainer,
  type AdbBindAddress,
  type RedroidImage,
  type RedroidParameter,
} from "./api"
import { Spinner, X } from "./icons"
import { Select, type SelectOption } from "./Select"
import {
  Button,
  controlCompactClass,
  controlClass,
  FailureBox,
  Field,
  IconButton,
  Section,
  SegmentedGroup,
  Switch,
} from "./ui"

const RESTART_POLICIES: ReadonlyArray<SelectOption<string>> = [
  { value: "no", label: "不自动重启" },
  { value: "on-failure", label: "失败退出时重启" },
  { value: "unless-stopped", label: "除非手动停止,否则重启" },
  { value: "always", label: "总是重启" },
]

interface Draft {
  name: string
  autoRemove: boolean
  restartPolicy: string
  adbPort: string
  adbBindAddress: AdbBindAddress
  dataMode: "none" | "bind" | "volume"
  dataSource: string
  values: Record<string, string>
  extra: string
}

// 从镜像标签猜一个容器名,比如 redroid/redroid:12.0.0_64only-latest
// 会猜成 redroid-12.0.0_64only。用户可以改。
const suggestName = (reference: string): string => {
  const tag = reference.split(":").pop() ?? "redroid"
  const cleaned = tag.replace(/-latest$/, "").replace(/[^a-zA-Z0-9_.-]/g, "-")
  return `redroid-${cleaned}`
}

const initialDraft = (image: RedroidImage): Draft => ({
  name: suggestName(image.reference),
  // 官方文档推荐的用法,所以默认勾上。
  autoRemove: true,
  // --rm 关掉之后的重启策略:默认不重启。
  restartPolicy: "no",
  // 留空 = 让后端自动挑一个
  adbPort: "",
  // 默认只听本机:adb 没鉴权,对外开等于把 Android 的 root 交出去。
  adbBindAddress: "127.0.0.1",
  dataMode: "none",
  dataSource: "",
  values: {},
  extra: "",
})

// 额外参数:一行一个 key=value。认不出来的行单独收集,好告诉用户。
const parseExtraLines = (
  text: string
): {
  readonly params: ReadonlyArray<{ name: string; value: string }>
  readonly invalid: ReadonlyArray<string>
} => {
  const params: { name: string; value: string }[] = []
  const invalid: string[] = []

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator <= 0) {
      invalid.push(line)
      continue
    }
    params.push({
      name: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    })
  }

  return { params, invalid }
}

const buildInput = (
  image: RedroidImage,
  draft: Draft,
  parameters: ReadonlyArray<RedroidParameter>
): CreateContainerInput => {
  // 先用目录里生成的输入框,再让"额外参数"盖上去 —— 同名的以手写为准。
  const merged = new Map<string, string>()
  for (const parameter of parameters) {
    if (parameter.pattern !== undefined) continue
    const value = (draft.values[parameter.name] ?? "").trim()
    if (value !== "") merged.set(parameter.name, value)
  }
  for (const param of parseExtraLines(draft.extra).params) {
    merged.set(param.name, param.value)
  }

  return {
    image: image.reference,
    name: draft.name.trim(),
    autoRemove: draft.autoRemove,
    restartPolicy: draft.restartPolicy,
    dataMount:
      draft.dataMode === "none"
        ? null
        : { kind: draft.dataMode, source: draft.dataSource.trim() },
    params: [...merged].map(([name, value]) => ({ name, value })),
    adbPort: draft.adbPort.trim() === "" ? null : Number(draft.adbPort),
    adbBindAddress: draft.adbBindAddress,
  }
}

const dataHint = (draft: Draft): { readonly text: string; readonly warn: boolean } => {
  if (draft.dataMode === "none") {
    return {
      text: draft.autoRemove
        ? "没挂 /data 又选了 --rm:停止一次,Android 里的数据就跟着没了。"
        : "没挂 /data:容器一删,Android 里的数据就没了。",
      warn: true,
    }
  }
  if (draft.dataMode === "bind") {
    return { text: "", warn: false }
  }
  return { text: "", warn: false }
}

// 参数名里有小数点(androidboot.redroid_width),直接当 id 用的话
// label 的 for 和选择器都别扭,所以换掉。
const inputId = (name: string): string =>
  `p-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`

interface Props {
  readonly image: RedroidImage
  readonly parameters: ReadonlyArray<RedroidParameter>
  readonly onCreated: (created: CreatedContainer) => void
  readonly onCancel: () => void
}

export const CreateContainerForm = ({
  image,
  parameters,
  onCreated,
  onCancel,
}: Props) => {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(image))
  const [filter, setFilter] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{
    readonly message: string
    readonly hint: string
  } | null>(null)

  const update = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  // 抽屉开着的时候:Esc 能关,底下的页面别跟着滚。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = previous
    }
  }, [onCancel])

  const extra = parseExtraLines(draft.extra)
  const catalog = parameters.filter((parameter) => parameter.pattern === undefined)
  const keyword = filter.trim().toLowerCase()
  const shown =
    keyword === ""
      ? catalog
      : catalog.filter(
          (parameter) =>
            parameter.name.toLowerCase().includes(keyword) ||
            parameter.summary.toLowerCase().includes(keyword)
        )

  const port = draft.adbPort.trim()
  const portBad = port !== "" && !/^\d+$/.test(port)
  const nameBad = draft.name.trim() === ""
  const hint = dataHint(draft)

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    try {
      onCreated(await createContainer(buildInput(image, draft, parameters)))
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

  const dataPlaceholder =
    draft.dataMode === "bind"
      ? `/home/你/redroid-data/${draft.name}`
      : `redroid-${draft.name}-data`

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="关掉创建面板"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="创建容器"
        className="animate-slide-in relative flex h-full w-full max-w-2xl flex-col border-l border-line bg-app shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">创建容器</h2>
            <p
              className="mt-0.5 truncate font-mono text-[11px] text-faint"
              title={image.reference}
            >
              {image.reference} · {image.architecture} · {formatSize(image.size)}
            </p>
          </div>
          <IconButton onClick={onCancel} aria-label="关闭">
            <X className="size-4" />
          </IconButton>
        </header>

        <div className="scroll-slim flex-1 space-y-7 overflow-y-auto px-5 py-5 sm:px-6">
          <Section title="基本信息">
            <Field label="容器名" htmlFor="new-name">
              <input
                id="new-name"
                autoFocus
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                className={controlClass}
              />
            </Field>

            <Field
              label="adb 端口"
              htmlFor="adb-port"
              tone={portBad ? "warn" : "muted"}
              hint={portBad ? "端口得是数字。" : undefined}
            >
              <input
                id="adb-port"
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                placeholder="留空 = 尝试自动挑一个"
                value={draft.adbPort}
                onChange={(event) => update({ adbPort: event.target.value })}
                className={controlClass}
              />
            </Field>

            <div>
              <span className="mb-1.5 block text-sm font-medium">
                adb 绑定地址
              </span>
              <SegmentedGroup
                value={draft.adbBindAddress}
                onChange={(next) => update({ adbBindAddress: next })}
                options={[
                  { value: "127.0.0.1", label: "仅本机" },
                  { value: "0.0.0.0", label: "所有网卡" },
                ]}
              />
              {draft.adbBindAddress === "0.0.0.0" && (
                <p className="mt-1.5 text-xs text-warn">
                  adb 没有鉴权,连上就是 Android 里的 root。
                </p>
              )}
            </div>

            <Switch
              checked={draft.autoRemove}
              onChange={(next) => update({ autoRemove: next })}
              label="停止时自动删除容器(--rm)"
            />

            {!draft.autoRemove && (
              <Field label="重启策略" htmlFor="restart">
                <Select
                  id="restart"
                  value={draft.restartPolicy}
                  options={RESTART_POLICIES}
                  onChange={(next) => update({ restartPolicy: next })}
                />
              </Field>
            )}
          </Section>

          <Section title="数据持久化">
            <SegmentedGroup
              value={draft.dataMode}
              onChange={(next) => update({ dataMode: next })}
              options={[
                { value: "none", label: "不挂载", hint: "数据跟着容器走" },
                { value: "bind", label: "宿主目录", hint: "自己挑一个路径" },
                { value: "volume", label: "Docker 卷", hint: "交给 Docker 管" },
              ]}
            />
            {draft.dataMode !== "none" && (
              <input
                aria-label="data 挂载的来源"
                value={draft.dataSource}
                placeholder={dataPlaceholder}
                onChange={(event) => update({ dataSource: event.target.value })}
                className={`${controlClass} font-mono text-[13px]`}
              />
            )}
            {hint.text !== "" && (
              <p className={`text-xs ${hint.warn ? "text-warn" : "text-faint"}`}>
                {hint.text}
              </p>
            )}
          </Section>

          <Section title="redroid 参数">
            <div className="flex items-center gap-2">
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="过滤参数…"
                className={`${controlClass} h-9`}
              />
              <span className="shrink-0 text-xs text-faint tabular-nums">
                {shown.length}/{catalog.length}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {shown.map((parameter) => (
                <div
                  key={parameter.name}
                  className="rounded-xl border border-line bg-panel px-3 py-2.5"
                >
                  <label
                    htmlFor={inputId(parameter.name)}
                    className="flex items-baseline justify-between gap-2 text-[13px]"
                  >
                    <span className="truncate" title={parameter.summary}>
                      {parameter.summary}
                    </span>
                  </label>
                  <p
                    className="mt-0.5 truncate font-mono text-[10px] text-faint"
                    title={parameter.name}
                  >
                    {parameter.name}
                  </p>
                  {parameter.allowedValues === undefined ? (
                    <input
                      id={inputId(parameter.name)}
                      value={draft.values[parameter.name] ?? ""}
                      placeholder={parameter.defaultValue ?? "未指定"}
                      onChange={(event) =>
                        update({
                          values: {
                            ...draft.values,
                            [parameter.name]: event.target.value,
                          },
                        })
                      }
                      className={`${controlCompactClass} mt-2`}
                    />
                  ) : (
                    <Select
                      id={inputId(parameter.name)}
                      value={draft.values[parameter.name] ?? ""}
                      size="sm"
                      mono
                      placeholder={`默认(${parameter.defaultValue ?? "未指定"})`}
                      options={parameter.allowedValues.map((value) => ({
                        value,
                        label: value,
                      }))}
                      onChange={(next) =>
                        update({
                          values: {
                            ...draft.values,
                            [parameter.name]: next,
                          },
                        })
                      }
                      className="mt-2"
                    />
                  )}
                </div>
              ))}
            </div>

            {shown.length === 0 && (
              <p className="text-xs text-faint">没有匹配的参数。</p>
            )}
          </Section>

          <Section title="额外参数">
            <textarea
              rows={4}
              value={draft.extra}
              placeholder="一行一个 key=value"
              onChange={(event) => update({ extra: event.target.value })}
              className={`${controlClass} font-mono`}
            />
            {extra.invalid.length > 0 && (
              <p className="text-xs text-warn">
                这几行看不懂,已经跳过了:{extra.invalid.join("、")}
              </p>
            )}
          </Section>

          {failure !== null && <FailureBox failure={failure} />}
        </div>

        <footer className="flex items-center gap-2 border-t border-line bg-panel px-5 py-4 sm:px-6">
          <Button onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            tone="primary"
            disabled={busy || nameBad || portBad}
            onClick={() => void submit()}
          >
            {busy && <Spinner className="size-4 animate-spin" />}
            {busy ? "创建中…" : "创建容器"}
          </Button>
        </footer>
      </div>
    </div>
  )
}
