import Docker from "dockerode"

/**
 * 这个文件只负责三件事:
 *
 *   1. 把 DOCKER_HOST 那串地址翻译成结构化的形式
 *   2. 照着它建一个 dockerode 客户端(就是"接通线路",不做 I/O)
 *   3. 真的连一次,确认连得上、而且我有权限
 *
 * 前两步对应 redroid-helper 里的 connect(),第三步对应 ping()。
 * 后面的所有功能(列镜像、构建镜像)都从这里拿客户端。
 *
 * dockerode 负责说话,我们负责把它的报错翻译成人话 —— 它给的原始错误
 * 长这样:`connect EACCES /var/run/docker.sock`,或者对着一个不是 Docker 的
 * 服务时会甩一整段 HTML 出来。
 */

/** Docker 地址的两种形态。unix socket 是本机,一般 Docker 默认就用这个。 */
export type DockerEndpoint =
  | { readonly kind: "unix"; readonly socketPath: string }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }

/** 不指定 DOCKER_HOST 时用这个,和 docker 命令行的默认值一致。 */
export const DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock"

/** 连不上时最多等多久,免得启动卡死。 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * 连不上的具体原因。分开写是为了能给用户一句对症的提示 ——
 * "Docker 没开" 和 "你没权限" 是两回事,不该混成一句"连接失败"。
 */
export type DockerFailureReason =
  | "bad-host"
  | "unsupported-scheme"
  | "socket-missing"
  | "permission-denied"
  | "connection-refused"
  | "timeout"
  | "not-docker"
  | "http-error"
  | "other"

/**
 * 跟 Docker 打交道失败。带上"是什么问题"和"该怎么办"。
 * 启动探活用它,后面查镜像、建镜像也用同一个。
 */
export class DockerFailure extends Error {
  readonly reason: DockerFailureReason
  readonly hint: string

  constructor(reason: DockerFailureReason, message: string, hint: string) {
    super(message)
    this.name = "DockerFailure"
    this.reason = reason
    this.hint = hint
  }
}

/** 用来打印给人看的地址。 */
export const describeDockerEndpoint = (endpoint: DockerEndpoint): string =>
  endpoint.kind === "unix"
    ? `unix://${endpoint.socketPath}`
    : `tcp://${endpoint.host}:${endpoint.port}`

/**
 * 决定这次到底连哪儿。优先级:命令行 > 带前缀的环境变量 > DOCKER_HOST > 默认值。
 *
 * 带前缀的那个(REDROID_WEB_DOCKER_HOST)排前面,是因为它明确写着"这是给
 * 这个程序用的";裸的 DOCKER_HOST 是 Docker 生态的公共约定,继续支持,
 * 但会让路 —— 万一你机器上它正被 docker 命令行用着,你还能单独给这个程序
 * 指个别的 daemon。
 *
 * 空字符串当没写(不然 DOCKER_HOST="" 会变成一个诡异的错误)。
 */
export const resolveDockerHost = (options: {
  readonly fromCli: string | undefined
  readonly env: Record<string, string | undefined>
}): string => {
  const candidates = [
    options.fromCli,
    options.env["REDROID_WEB_DOCKER_HOST"],
    options.env["DOCKER_HOST"],
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== "") {
      return candidate.trim()
    }
  }
  return DEFAULT_DOCKER_HOST
}

const badHost = (message: string, hint: string) =>
  new DockerFailure("bad-host", message, hint)

const unsupported = (message: string, hint: string) =>
  new DockerFailure("unsupported-scheme", message, hint)

/**
 * 把 "unix:///var/run/docker.sock" 这种字符串翻译成结构化的地址。
 * 写错了就在这里立刻报错,不让它跑到后面变成看不懂的连接失败。
 */
export const parseDockerHost = (raw: string): DockerEndpoint => {
  if (raw.startsWith("unix://")) {
    const socketPath = raw.slice("unix://".length)
    if (!socketPath.startsWith("/")) {
      throw badHost(
        `unix socket 要写绝对路径,收到的是:${raw}`,
        "正确写法是 unix:///var/run/docker.sock —— unix:// 后面跟三个斜杠"
      )
    }
    return { kind: "unix", socketPath }
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase()
  if (scheme === undefined) {
    throw badHost(
      `地址没有协议前缀,看不懂:${raw}`,
      "要写成 unix:///var/run/docker.sock 或者 tcp://127.0.0.1:2375"
    )
  }
  if (scheme === "https") {
    throw unsupported(
      "TLS 还没做,现在不能连 https:// 的 Docker",
      "那需要证书文件(DOCKER_CERT_PATH),是后面的事。先连本机的 unix:// 或者明文的 tcp://"
    )
  }
  if (scheme === "ssh") {
    throw unsupported(
      "ssh:// 还没做,现在不能通过 SSH 连远程 Docker",
      "先连本机的 unix:// 或者明文的 tcp://"
    )
  }
  if (scheme !== "tcp" && scheme !== "http") {
    throw unsupported(
      `不认识的协议:${scheme}://`,
      "现在支持 unix://(本机 socket)和 tcp:// 或 http://(网络地址)"
    )
  }

  const url = new URL(raw)
  if (url.hostname === "") {
    throw badHost(`地址里没有主机名:${raw}`, "要写成 tcp://127.0.0.1:2375")
  }
  return {
    kind: "tcp",
    host: url.hostname,
    port: url.port === "" ? 2375 : Number(url.port),
  }
}

/**
 * 建一个 dockerode 客户端。这一步不做任何网络请求,只是把"连哪儿"记下来,
 * 所以它不会失败,也不需要 await。
 *
 * 刻意**不设** timeout:dockerode 的 timeout 是"每个请求"的超时,而且是
 * 客户端级别的。一旦设上,停止容器(最多要等十几秒)、以后拉镜像、构建镜像
 * 都会被它掐断 —— 实测设 5 秒时,停容器会得到 "socket hang up"。
 * 需要"最多等多久"的地方(比如启动探测)自己用 AbortSignal 控制。
 */
export const connectDocker = (endpoint: DockerEndpoint): Docker =>
  endpoint.kind === "unix"
    ? new Docker({ socketPath: endpoint.socketPath })
    : new Docker({ host: endpoint.host, port: endpoint.port })

/** 连上了的话,从 Docker 那里问到的信息。 */
export interface DockerInfo {
  readonly version: string
  readonly apiVersion: string
}

// dockerode 的 version() 在运行时是支持 abortSignal 的(它内部就是把这个
// signal 交给底层 HTTP 请求),但 @types/dockerode 没有声明这个重载。
// 这里补一个我们确实会用的签名 —— 绕过的只是类型,不是行为。
const versionWithAbort = (
  docker: Docker,
  signal: AbortSignal
): Promise<Docker.DockerVersion> => {
  const version = docker.version.bind(docker) as unknown as (options: {
    readonly abortSignal: AbortSignal
  }) => Promise<Docker.DockerVersion>
  return version({ abortSignal: signal })
}

/**
 * 真的去连一次问版本。
 *
 * 用 GET /version 而不是 GET /_ping:两个都是 Docker 不需要认证的便宜接口,
 * 但 /version 会返回一段 JSON,顺带证明了"对面确实是 Docker",而不是你地址
 * 写错、连到了别的什么服务上。而且它还真的给了我们版本号。
 */
export const probeDocker = async (
  docker: Docker,
  endpoint: DockerEndpoint
): Promise<DockerInfo> => {
  // 探测是启动路径上的一步,不该无限等下去。这个超时只作用于这一次请求,
  // 不污染后面那些本来就可能很慢的操作。
  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, PROBE_TIMEOUT_MS)

  let info
  try {
    info = await versionWithAbort(docker, abort.signal)
  } catch (error) {
    if (timedOut) {
      throw new DockerFailure(
        "timeout",
        `等了 ${PROBE_TIMEOUT_MS / 1000} 秒,Docker 一直没有回应`,
        "地址和端口确认一下,或者对方防火墙没放行。"
      )
    }
    // 探测用的是 /version:对面只要不是 Docker,这个接口就不会正常返回,
    // 所以这里的 4xx 不该理解成"接口用错了",而是"对面不是 Docker"。
    // 这一层判断只属于探测,不放进共享的翻译函数里。
    const status = statusCodeOf(error)
    if (status !== undefined && status < 500 && status !== 401 && status !== 403) {
      throw new DockerFailure(
        "not-docker",
        `${describeDockerEndpoint(endpoint)} 上有服务在应答,但它不像 Docker(HTTP ${status})`,
        "地址大概写错了,或者那个端口上跑着别的服务。"
      )
    }
    throw translateDockerError(endpoint, error)
  } finally {
    clearTimeout(timer)
  }

  // 应答了、但内容不像 Docker 的版本信息
  if (typeof info.Version !== "string" || info.Version === "") {
    throw new DockerFailure(
      "not-docker",
      `${describeDockerEndpoint(endpoint)} 上有服务在应答,但它不是 Docker`,
      "地址大概写错了,或者那个端口上跑着别的服务。"
    )
  }

  return {
    version: info.Version,
    apiVersion: typeof info.ApiVersion === "string" ? info.ApiVersion : "未知",
  }
}

/**
 * 把 dockerode / Node 底层抛出来的错误翻译成人话。
 * 这里就是"检查是否具备通信权限"真正落地的地方 —— 系统给的 EACCES 太晦涩了。
 */
const fieldOf = (error: unknown, name: string): unknown =>
  typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[name]
    : undefined

/**
 * 从错误里取 HTTP 状态码(dockerode 把它放在 statusCode 上)。
 *
 * 为什么单独暴露出来:状态码的含义**跟具体接口有关**。404 对 /version 来说
 * 是"对面不是 Docker",对"查某个容器"来说是"没这个容器"。所以底层翻译只管
 * "连不上"这一类,状态码交给各个模块按自己的语义解释。
 */
export const statusCodeOf = (error: unknown): number | undefined => {
  const value = fieldOf(error, "statusCode")
  return typeof value === "number" ? value : undefined
}

export const translateDockerError = (
  endpoint: DockerEndpoint,
  error: unknown
): DockerFailure => {
  if (error instanceof DockerFailure) return error

  const where = describeDockerEndpoint(endpoint)
  const code = fieldOf(error, "code")
  switch (code) {
    case "ENOENT":
      return new DockerFailure(
        "socket-missing",
        `找不到 ${where}`,
        endpoint.kind === "unix"
          ? "这个路径上没有 socket,多半是 Docker 没在运行。先运行 docker info 确认一下。"
          : "这个地址上没有服务在监听。"
      )
    case "EACCES":
    case "EPERM":
      return new DockerFailure(
        "permission-denied",
        `找到了 ${where},但当前用户没有权限访问它`,
        endpoint.kind === "unix"
          ? "你不在 docker 组里。执行 sudo usermod -aG docker $USER 把自己加进去,然后重新登录(要重新登录才生效)。"
          : "对方拒绝了连接。"
      )
    case "ECONNREFUSED":
      return new DockerFailure(
        "connection-refused",
        `${where} 拒绝连接`,
        "地址是通的,但没有服务愿意接受连接 —— 确认 Docker 是否开放了 TCP 端口。"
      )
    case "ETIMEDOUT":
      return new DockerFailure(
        "timeout",
        `连接 ${where} 超时`,
        "网络不通,或者对方防火墙没放行。"
      )
  }

  // 走到这里说明是"连上了,但对面不满意"。dockerode 会把 HTTP 状态码放在
  // statusCode 上,而它的 message 里会塞进整个响应体(可能是一大段 HTML),
  // 所以这里不能直接把 message 抛给用户。
  //
  // 注意这里**不猜**状态码的含义:404 对查容器来说是"没这个容器",对
  // /version 来说是"对面不是 Docker"。猜错了会给出误导人的提示,所以
  // 各模块自己判断,判断不了再落到这里。
  const status = statusCodeOf(error)
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return new DockerFailure(
        "http-error",
        `${where} 拒绝了这次请求(HTTP ${status}),像是权限或认证的问题`,
        "确认当前用户有没有权限访问 Docker。"
      )
    }
    if (status >= 500) {
      return new DockerFailure(
        "http-error",
        `${where} 上的服务报错了(HTTP ${status})`,
        "Docker 自己出了问题,先看看 dockerd 的日志。"
      )
    }
    return new DockerFailure(
      "http-error",
      `Docker 返回了 HTTP ${status}`,
      "这个状态码的含义跟具体操作有关,先看看 dockerd 的日志。"
    )
  }

  return new DockerFailure(
    "other",
    `连接 ${where} 时出错:${summarize(error)}`,
    ""
  )
}

/** 截断过长的错误信息,免得一整段 HTML 刷屏。 */
const summarize = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  const firstLine = text.split("\n", 1)[0] ?? text
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}
