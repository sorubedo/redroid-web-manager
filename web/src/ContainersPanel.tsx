import { useState, type ReactNode } from "react"
import {
  ApiFailure,
  fetchContainers,
  removeContainer,
  startContainer,
  stateLabel,
  stopContainer,
  type ContainerParam,
  type RedroidContainer,
} from "./api"
import { EmptyBox, FailureBox, Toolbar } from "./Bits"
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

const formatTime = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN")
}

const explain = (param: ContainerParam): string => {
  const parameter = param.parameter
  if (parameter === null) return "不在官方文档里"
  const parts = [parameter.summary]
  if (parameter.defaultValue !== undefined) {
    parts.push(`默认 ${parameter.defaultValue}`)
  }
  if (parameter.allowedValues !== undefined) {
    parts.push(`可选 ${parameter.allowedValues.join(" / ")}`)
  }
  return parts.join(" · ")
}

const Row = ({
  label,
  children,
  warn = false,
}: {
  readonly label: string
  readonly children: ReactNode
  readonly warn?: boolean
}) => (
  <div className="row">
    <span className="row-label">{label}</span>
    <span className={warn ? "warn" : undefined}>{children}</span>
  </div>
)

interface CardProps {
  readonly container: RedroidContainer
  readonly busyLabel: string | null
  readonly error: { readonly message: string; readonly hint: string } | null
  readonly onStart: () => void
  readonly onStop: () => void
  readonly onRemove: () => void
}

const Card = ({
  container,
  busyLabel,
  error,
  onStart,
  onStop,
  onRemove,
}: CardProps) => {
  const [confirming, setConfirming] = useState<"stop" | "remove" | null>(null)
  const busy = busyLabel !== null
  const running = container.state === "running"

  // --rm 的容器,停止就等于删除。所以这种容器不给"删除"按钮:
  // 它要么是多余的(和停止一模一样),要么会撞上 Docker 的自动删除。
  const stopDeletes = running && container.autoRemove

  const confirmText =
    confirming === "stop"
      ? "这个容器带 --rm,停止之后 Docker 会把它删掉。确定停止?"
      : confirming === "remove"
        ? container.dataSource === null
          ? "容器会被删除,无法恢复。确定?"
          : `容器会被删除。它挂的 /data(${container.dataSource})会留在宿主机上,数据不会丢。确定?`
        : null

  const runConfirmed = () => {
    const action = confirming
    setConfirming(null)
    if (action === "stop") onStop()
    else if (action === "remove") onRemove()
  }

  return (
    <article className="card">
      <div className="card-head">
        <h3 className="mono">{container.name}</h3>
        <span className={`badge ${container.state}`}>
          {stateLabel(container.state)}
        </span>
      </div>

      <p className="mono muted">{container.image}</p>

      <div className="rows">
        <Row label="状态">{container.status}</Row>
        <Row label="启动策略">{restartPolicyLabel(container.restartPolicy)}</Row>
        <Row label="adb 端口" warn={container.adbPort === null}>
          {container.adbPort === null
            ? "没映射 5555,连不上 adb"
            : `5555 → 宿主 ${container.adbPort}`}
        </Row>
        <Row label="特权模式" warn={!container.privileged}>
          {container.privileged ? "已开启" : "没开,redroid 需要 --privileged"}
        </Row>
        <Row label="data 持久化" warn={container.dataSource === null}>
          {container.dataSource ?? "没挂 /data,容器一删数据就没了"}
        </Row>
        <Row label="创建时间">{formatTime(container.createdAt)}</Row>
      </div>

      {container.autoRemove && (
        <p className="warn">
          这个容器是用 --rm 起的:停止它 = 删除它。
          {running ? "所以这里只给了一个停止按钮。" : ""}
        </p>
      )}

      <div className="actions">
        {running ? (
          <button
            type="button"
            className={stopDeletes ? "danger" : undefined}
            disabled={busy}
            onClick={() => (stopDeletes ? setConfirming("stop") : onStop())}
          >
            {stopDeletes ? "停止并删除" : "停止"}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onStart}>
            启动
          </button>
        )}
        {!stopDeletes && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => setConfirming("remove")}
          >
            删除
          </button>
        )}
        {busyLabel !== null && <span className="muted">{busyLabel}</span>}
      </div>

      {confirmText !== null && (
        <div className="confirm">
          <span>{confirmText}</span>
          <button type="button" className="danger" onClick={runConfirmed}>
            确定
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            取消
          </button>
        </div>
      )}

      {error !== null && (
        <div className="failure">
          <strong>{error.message}</strong>
          {error.hint !== "" && <p>{error.hint}</p>}
        </div>
      )}

      <h4>启动参数 ({container.params.length})</h4>
      {container.params.length === 0 ? (
        <p className="muted">全部用默认值。</p>
      ) : (
        <table className="params">
          <thead>
            <tr>
              <th>参数</th>
              <th>值</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {container.params.map((param) => (
              <tr key={param.name}>
                <td className="mono">{param.name}</td>
                <td className="mono">{param.value}</td>
                <td className={param.parameter === null ? "muted" : undefined}>
                  {explain(param)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

  return (
    <>
      <Toolbar busy={busy} reload={reload}>
        {data === null
          ? "本机 Docker 里已创建的 redroid 容器"
          : `共 ${data.length} 个`}
      </Toolbar>

      {failure !== null && <FailureBox failure={failure} />}

      {failure === null && data !== null && data.length === 0 && (
        <EmptyBox>
          <p>还没有创建过 redroid 容器。</p>
          <p>
            手动起一个试试:
            <code>docker run -itd --privileged -p 5555:5555 redroid/redroid:12.0.0_64only-latest</code>
          </p>
        </EmptyBox>
      )}

      {data?.map((container) => (
        <Card
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
        />
      ))}
    </>
  )
}
