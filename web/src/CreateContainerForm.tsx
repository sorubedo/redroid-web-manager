import { useState } from "react"
import {
  ApiFailure,
  createContainer,
  type CreateContainerInput,
  type CreatedContainer,
  type RedroidImage,
  type RedroidParameter,
} from "./api"

interface Draft {
  name: string
  autoRemove: boolean
  restartPolicy: string
  adbPort: string
  dataMode: "none" | "bind" | "volume"
  dataSource: string
  values: Record<string, string>
  extra: string
}

// 从镜像标签猜一个容器名,比如 redroid/redroid:12.0.0_64only-latest
// 会猜成 redroid-12.0.0_64only。用户可以直接改。
const suggestName = (reference: string): string => {
  const tag = reference.split(":").pop() ?? "redroid"
  const cleaned = tag.replace(/-latest$/, "").replace(/[^a-zA-Z0-9_.-]/g, "-")
  return `redroid-${cleaned}`
}

const initialDraft = (image: RedroidImage): Draft => ({
  name: suggestName(image.reference),
  // 官方文档推荐的用法,所以默认就勾上。
  autoRemove: true,
  // --rm 关掉之后的重启策略:默认不重启。
  restartPolicy: "no",
  // 留空 = 自动挑一个
  adbPort: "",
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
  }
}

const dataHint = (draft: Draft): string => {
  if (draft.dataMode === "none") {
    return draft.autoRemove
      ? "没挂 /data,又选了 --rm:每次停止,Android 里的数据都会跟着没。"
      : "没挂 /data,容器一删 Android 里的数据就没了。"
  }
  if (draft.dataMode === "bind") {
    return "宿主上的绝对路径。目录不存在的话 Docker 会自己建。"
  }
  return "让 Docker 管的卷。名字随便取,不存在会自动创建。"
}

// 参数名里有小数点(androidboot.redroid_width),直接用做 id 的话
// label 的 for 和 CSS 选择器都会别扭,所以换掉。
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
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{
    message: string
    hint: string
  } | null>(null)

  const update = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  const extra = parseExtraLines(draft.extra)
  const catalogParams = parameters.filter((p) => p.pattern === undefined)

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
    <section className="card create-form">
      <div className="card-head">
        <h3>创建容器</h3>
        <span className="mono muted">{image.reference}</span>
      </div>

      <div className="field">
        <label htmlFor="new-name">容器名</label>
        <input
          id="new-name"
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
        />
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={draft.autoRemove}
          onChange={(event) => update({ autoRemove: event.target.checked })}
        />
        <span>
          停止时自动删掉容器(<code>--rm</code>)
          <span className="muted"> · 推荐,redroid 官方文档就是这么用的</span>
        </span>
      </label>

      {!draft.autoRemove && (
        <div className="field">
          <label htmlFor="restart">重启策略</label>
          <select
            id="restart"
            value={draft.restartPolicy}
            onChange={(event) => update({ restartPolicy: event.target.value })}
          >
            <option value="no">不自动重启(推荐)</option>
            <option value="on-failure">失败退出时重启</option>
            <option value="unless-stopped">除非手动停止,否则重启</option>
            <option value="always">总是重启</option>
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor="adb-port">adb 端口</label>
        <input
          id="adb-port"
          type="number"
          min={1}
          max={65535}
          placeholder="留空就自动挑一个"
          value={draft.adbPort}
          onChange={(event) => update({ adbPort: event.target.value })}
        />
        <p className="muted">
          宿主上映射到容器里 5555 的端口。留空就从 5555 往上找第一个没人占的。
        </p>
      </div>

      <fieldset className="field">
        <legend>data 挂载</legend>
        <div className="radios">
          {(
            [
              ["none", "不挂载"],
              ["bind", "宿主目录"],
              ["volume", "Docker 卷"],
            ] as const
          ).map(([mode, label]) => (
            <label key={mode}>
              <input
                type="radio"
                name="dataMode"
                checked={draft.dataMode === mode}
                onChange={() => update({ dataMode: mode })}
              />
              {label}
            </label>
          ))}
        </div>
        {draft.dataMode !== "none" && (
          <input
            id="data-source"
            value={draft.dataSource}
            placeholder={dataPlaceholder}
            onChange={(event) => update({ dataSource: event.target.value })}
          />
        )}
        <p className={draft.dataMode === "none" ? "warn" : "muted"}>
          {dataHint(draft)}
        </p>
      </fieldset>

      <fieldset className="field">
        <legend>redroid 参数(留空就用默认值)</legend>
        <div className="params-grid">
          {catalogParams.map((parameter) => (
            <div className="param-row" key={parameter.name}>
              <label htmlFor={inputId(parameter.name)} title={parameter.name}>
                {parameter.summary}
              </label>
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
                />
              ) : (
                <select
                  id={inputId(parameter.name)}
                  value={draft.values[parameter.name] ?? ""}
                  onChange={(event) =>
                    update({
                      values: {
                        ...draft.values,
                        [parameter.name]: event.target.value,
                      },
                    })
                  }
                >
                  <option value="">
                    默认({parameter.defaultValue ?? "未指定"})
                  </option>
                  {parameter.allowedValues.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>额外参数</legend>
        <textarea
          rows={3}
          value={draft.extra}
          placeholder={
            "一行一个 key=value,比如:\nandroidboot.redroid_net_dns1=8.8.8.8\nro.secure=0"
          }
          onChange={(event) => update({ extra: event.target.value })}
        />
        <p className="muted">
          上面没列出来的参数写在这儿,和上面重名的以这里为准。
        </p>
        {extra.invalid.length > 0 && (
          <p className="warn">
            这几行看不懂,已经跳过了:{extra.invalid.join("、")}
          </p>
        )}
      </fieldset>

      {failure !== null && (
        <div className="failure">
          <strong>{failure.message}</strong>
          {failure.hint !== "" && <p>{failure.hint}</p>}
        </div>
      )}

      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? "创建中…" : "创建"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  )
}
