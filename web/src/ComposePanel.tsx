import { useState } from "react"
import {
  ApiFailure,
  composeImage,
  fetchBaseImages,
  type ComposeEvent,
  type RedroidImage,
} from "./api"
import { FailureBox } from "./Bits"
import { useRemote } from "./useRemote"

// 输出标签的默认值:在基础镜像的标签后面加 -custom。
// 用户可以改。注意不能和基础镜像完全相同 —— 后端也会拦,这里先给个好默认。
const suggestTarget = (reference: string): string => `${reference}-custom`

export const ComposePanel = () => {
  const images = useRemote<ReadonlyArray<RedroidImage>>(fetchBaseImages)

  const [base, setBase] = useState("")
  const [target, setTarget] = useState("")
  const [files, setFiles] = useState<ReadonlyArray<File>>([])
  const [lines, setLines] = useState<ReadonlyArray<string>>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ target: string } | null>(null)
  const [failure, setFailure] = useState<{
    message: string
    hint: string
  } | null>(null)

  const chooseBase = (reference: string) => {
    setBase(reference)
    setTarget(suggestTarget(reference))
  }

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    setResult(null)
    setLines([])

    const form = new FormData()
    // 字段要排在文件前面:后端是边收边处理,得先知道 base/target。
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
        } else if (event.type === "done") {
          setResult({ target: event.target ?? target })
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

  return (
    <>
      <p className="muted">
        拿一张原版 redroid 镜像做底,叠上一个或多个 tar 包,产出一张新镜像。
        tar 里是什么由你决定 —— 程序只看得到 tar,不关心里面装的是 Magisk
        还是别的东西。
      </p>

      {images.failure !== null && <FailureBox failure={images.failure} />}

      {images.data !== null && images.data.length === 0 && (
        <div className="empty">
          <p>本机没有原版 redroid 镜像,没得选。</p>
          <p>
            先拉一个:
            <code>docker pull redroid/redroid:14.0.0_64only-latest</code>
          </p>
        </div>
      )}

      {images.data !== null && images.data.length > 0 && (
        <section className="card create-form">
          <div className="field">
            <label htmlFor="compose-base">基础镜像</label>
            <select
              id="compose-base"
              value={base}
              onChange={(event) => chooseBase(event.target.value)}
            >
              <option value="">选一张原版镜像…</option>
              {images.data.map((image) => (
                <option key={image.reference} value={image.reference}>
                  {image.reference}({image.architecture})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="compose-target">输出标签</label>
            <input
              id="compose-target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
            <p className="muted">
              合成出来的镜像叫什么。名字里不能有空格和换行。
            </p>
          </div>

          <div className="field">
            <label htmlFor="compose-layers">层(tar 包,可以选多个)</label>
            <input
              id="compose-layers"
              type="file"
              multiple
              accept=".tar,application/x-tar"
              onChange={(event) =>
                setFiles(Array.from(event.target.files ?? []))
              }
            />
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((file) => (
                  <li key={file.name}>
                    <span className="mono">{file.name}</span>
                    <span className="muted">
                      {(file.size / 1024 / 1024).toFixed(1)} MiB
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">
              按选中的顺序叠上去。tar 会被解开到镜像根目录(就是
              Dockerfile 里 ADD 那个行为)。
            </p>
          </div>

          {result !== null && (
            <div className="success">
              <strong>合成完成:{result.target}</strong>
              <p>回「镜像」那一页就能拿它创建容器了。</p>
            </div>
          )}

          {failure !== null && <FailureBox failure={failure} />}

          <div className="actions">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void submit()}
            >
              {busy ? "合成中…" : "开始合成"}
            </button>
          </div>

          {lines.length > 0 && (
            <pre className="build-log">{lines.join("\n")}</pre>
          )}
        </section>
      )}
    </>
  )
}
