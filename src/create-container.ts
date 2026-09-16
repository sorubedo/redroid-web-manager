import type Docker from "dockerode"
import type { DataMount } from "./containers.js"
import {
  statusCodeOf,
  translateDockerError,
  type DockerEndpoint,
} from "./docker-host.js"
import { MANAGED_LABEL } from "./labels.js"
import type { BootParam } from "./redroid-params.js"

// 从一张 redroid 镜像创建一台新容器。
//
// 对外只有一个函数,底下藏着调用者(HTTP 层、界面)不该操心的四件事:
//
//   1. 校验输入 —— 全是从网络上来的,不能信
//   2. 挑一个没人占的 adb 端口
//   3. 把上面这些翻译成 Docker 那一堆嵌套很深的创建参数
//   4. 建完顺手启动 —— 一台不跑的 redroid 容器没有任何意义

export type RestartPolicy = "no" | "always" | "unless-stopped" | "on-failure"

/**
 * adb 端口绑到宿主的哪个地址上。
 *
 * 默认只有本机:Docker 的 -p 不写地址时是绑所有网卡的,而 adb 没有鉴权,
 * 连上就是 Android 里的 root —— 那等于把机器敞开在网络上。要远程连的时候
 * 再单独打开,并且自己想清楚前面有没有别的防护。
 */
export const ADB_BIND_ADDRESSES = ["127.0.0.1", "0.0.0.0"] as const

export type AdbBindAddress = (typeof ADB_BIND_ADDRESSES)[number]

export const DEFAULT_ADB_BIND_ADDRESS: AdbBindAddress = "127.0.0.1"

export interface RedroidContainerSpec {
  readonly image: string
  readonly name: string
  /** 官方文档推荐的 --rm:容器一停就自动删掉 */
  readonly autoRemove: boolean
  /** 只在 autoRemove 为 false 时有意义 */
  readonly restartPolicy: RestartPolicy
  readonly dataMount: DataMount | null
  readonly params: ReadonlyArray<BootParam>
  /** 宿主端口 -> 容器里的 5555;null 表示自动挑一个 */
  readonly adbPort: number | null
  /** 上面那个端口绑在宿主的哪个地址上 */
  readonly adbBindAddress: AdbBindAddress
}

export interface CreatedContainer {
  readonly name: string
  readonly adbPort: number
}

/** 传进来的配置不合法。带上哪个字段不对,方便界面指出位置。 */
export class InvalidContainerSpec extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = "InvalidContainerSpec"
    this.field = field
  }
}

/** 已经有一个同名容器了。 */
export class ContainerNameTaken extends Error {
  readonly containerName: string

  constructor(containerName: string) {
    super(`已经有一个叫 ${containerName} 的容器了,换个名字`)
    this.name = "ContainerNameTaken"
    this.containerName = containerName
  }
}

/** 宿主上没空了 —— 5555 往上一段全被占了。 */
export class NoFreeAdbPort extends Error {
  constructor(from: number, to: number) {
    super(`宿主上 ${from} 到 ${to} 之间没有空闲端口了`)
    this.name = "NoFreeAdbPort"
  }
}

/**
 * 指定的端口被别的容器占了。
 *
 * 这一条必须我们自己查:Docker 在**创建**容器时不检查端口冲突,等到**启动**
 * 才报 "port is already allocated"。那时候容器已经建出来了,用户得到一个
 * 建了一半的坏容器 —— 只是为了一个端口号填错。
 */
export class AdbPortTaken extends Error {
  readonly port: number

  constructor(port: number) {
    super(
      `宿主上的 ${port} 端口已经被别的容器占用了。换一个,或者留空让程序自动挑。`
    )
    this.name = "AdbPortTaken"
    this.port = port
  }
}

/**
 * 容器建出来了,但没跑起来。
 *
 * 注意**不删这个容器** —— redroid 起不来的原因通常要看它的日志,容器留着
 * 才有得看。错误消息里会说清楚这一点。
 */
export class ContainerStartFailed extends Error {
  readonly containerName: string

  constructor(containerName: string, reason: string) {
    super(
      `容器 ${containerName} 已经建好了,但启动失败:${reason}。容器留在那儿了,可以看看它的日志。`
    )
    this.name = "ContainerStartFailed"
    this.containerName = containerName
  }
}

export const createRedroidContainer = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  input: unknown
): Promise<CreatedContainer> => {
  const spec = parseSpec(input)
  const adbPort = resolveAdbPort(
    spec.adbPort,
    await takenPorts(docker, endpoint)
  )

  try {
    await docker.createContainer(toDockerOptions(spec, adbPort))
  } catch (error) {
    // Docker 在建容器时回 409,基本上就是名字被占了(也可能是指定了不存在的
    // 卷之类)。这里按最常见的意思解释,消息里带上名字,不对的话用户也看得出来。
    if (statusCodeOf(error) === 409) throw new ContainerNameTaken(spec.name)
    throw translateDockerError(endpoint, error)
  }

  try {
    await docker.getContainer(spec.name).start()
  } catch (error) {
    throw new ContainerStartFailed(
      spec.name,
      translateDockerError(endpoint, error).message
    )
  }

  return { name: spec.name, adbPort }
}

/* ---------- 内部实现 ---------- */

const ADB_PORT_IN_CONTAINER = "5555/tcp"
const ADB_PORT_BASE = 5555
const ADB_PORT_RANGE = 100

// Docker 的容器名规则。名字会被放进 URL 路径里,所以这里必须卡住。
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
// 参数名:字母数字加点、下划线、短横线。不允许 = ,因为要拼成 key=value。
const PARAM_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const RESTART_POLICIES: ReadonlyArray<RestartPolicy> = [
  "no",
  "always",
  "unless-stopped",
  "on-failure",
]

const invalid = (field: string, message: string) =>
  new InvalidContainerSpec(field, message)

const asRecord = (
  value: unknown,
  field: string
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(field, "请求体应该是一个 JSON 对象")
  }
  return value as Record<string, unknown>
}

const requireText = (
  source: Record<string, unknown>,
  field: string,
  label: string
): string => {
  const value = source[field]
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(field, `${label}不能为空`)
  }
  return value.trim()
}

const optionalInteger = (
  value: unknown,
  field: string,
  label: string
): number | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(field, `${label}得是整数`)
  }
  if (value < 1 || value > 65535) {
    throw invalid(field, `${label}得在 1 到 65535 之间`)
  }
  return value
}

const parseRestartPolicy = (value: unknown): RestartPolicy => {
  if (value === undefined || value === null) return "no"
  if (
    typeof value !== "string" ||
    !RESTART_POLICIES.includes(value as RestartPolicy)
  ) {
    throw invalid(
      "restartPolicy",
      `重启策略只能是 ${RESTART_POLICIES.join(" / ")}`
    )
  }
  return value as RestartPolicy
}

const parseDataMount = (value: unknown): DataMount | null => {
  if (value === undefined || value === null) return null
  const record = asRecord(value, "dataMount")
  const source = requireText(record, "source", "目录/卷名")
  if (record.kind === "bind") {
    if (!source.startsWith("/")) {
      throw invalid(
        "dataMount.source",
        `挂目录要写宿主上的绝对路径,收到的是:${source}`
      )
    }
    return { kind: "bind", source }
  }
  if (record.kind === "volume") {
    if (!CONTAINER_NAME.test(source)) {
      throw invalid("dataMount.source", `卷名不合法:${source}`)
    }
    return { kind: "volume", name: source }
  }
  throw invalid("dataMount.kind", "dataMount.kind 只能是 bind 或 volume")
}

const parseAdbBindAddress = (value: unknown): AdbBindAddress => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ADB_BIND_ADDRESS
  }
  if (
    typeof value === "string" &&
    (ADB_BIND_ADDRESSES as ReadonlyArray<string>).includes(value)
  ) {
    return value as AdbBindAddress
  }
  throw invalid(
    "adbBindAddress",
    `adb 绑定地址只能是 ${ADB_BIND_ADDRESSES.join(" 或 ")},收到的是:${String(value)}`
  )
}

const parseParams = (value: unknown): ReadonlyArray<BootParam> => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid("params", "params 得是一个数组")

  return value.map((entry, index) => {
    const record = asRecord(entry, `params[${index}]`)
    const name = requireText(record, "name", "参数名")
    const paramValue = record.value
    if (!PARAM_NAME.test(name)) {
      throw invalid(`params[${index}].name`, `参数名不合法:${name}`)
    }
    if (typeof paramValue !== "string") {
      throw invalid(`params[${index}].value`, `参数 ${name} 的值得是字符串`)
    }
    return { name, value: paramValue }
  })
}

/**
 * 校验并收窄外面传进来的东西。
 *
 * 参数类型故意是 unknown:这些值是从网络上来的,类型上说"它是个
 * RedroidContainerSpec"只是自欺欺人。校验放在这里,而不是 HTTP 层 ——
 * "什么样的 spec 算合法"是这个模块的事。
 */
const parseSpec = (input: unknown): RedroidContainerSpec => {
  const record = asRecord(input, "body")

  const image = requireText(record, "image", "镜像")
  const name = requireText(record, "name", "容器名")
  if (!CONTAINER_NAME.test(name)) {
    throw invalid(
      "name",
      `容器名只能用字母、数字、下划线、点和短横线,而且不能以符号开头:${name}`
    )
  }

  const autoRemove = record.autoRemove === true

  return {
    image,
    name,
    autoRemove,
    // --rm 和重启策略是互斥的:--rm 的容器一退出就被删了,"重启"没有对象。
    // 所以选了 --rm 就固定成 no。
    restartPolicy: autoRemove ? "no" : parseRestartPolicy(record.restartPolicy),
    dataMount: parseDataMount(record.dataMount),
    params: parseParams(record.params),
    adbPort: optionalInteger(record.adbPort, "adbPort", "adb 端口"),
    adbBindAddress: parseAdbBindAddress(record.adbBindAddress),
  }
}

/**
 * 宿主上现在被占掉的端口。
 *
 * 为什么要一个个 inspect,而不是看列表接口给的 Ports:Docker 只在容器**跑起来
 * 之后**才填实际绑定,所以"建了但没启动"的容器在列表里看不到端口,会造成两台
 * 新容器抢同一个端口。inspect 里始终有"想绑到哪"的记录。
 */
const takenPorts = async (
  docker: Docker,
  endpoint: DockerEndpoint
): Promise<ReadonlySet<number>> => {
  const summaries = await request(endpoint, () =>
    docker.listContainers({ all: true })
  )

  const ports = new Set<number>()
  for (const summary of summaries) {
    const inspect = await request(endpoint, () =>
      docker.getContainer(summary.Id).inspect()
    )
    const bindings = inspect.HostConfig?.PortBindings as
      | Record<string, ReadonlyArray<{ HostPort?: string }> | null>
      | null
      | undefined
    for (const list of Object.values(bindings ?? {})) {
      for (const binding of list ?? []) {
        const port = Number(binding.HostPort)
        if (Number.isInteger(port) && port > 0) ports.add(port)
      }
    }
  }
  return ports
}

/**
 * 定下这次用哪个宿主端口。
 *
 * 用户指定了就用他指定的 —— 但得先确认没人占。这一条不能省:Docker 创建
 * 容器时**不**检查端口冲突,等启动才报错,那时候坏容器已经建出来了。
 * 没指定就从 5555 往上找第一个空的。
 */
const resolveAdbPort = (
  requested: number | null,
  taken: ReadonlySet<number>
): number => {
  if (requested !== null) {
    if (taken.has(requested)) throw new AdbPortTaken(requested)
    return requested
  }
  for (let port = ADB_PORT_BASE; port < ADB_PORT_BASE + ADB_PORT_RANGE; port++) {
    if (!taken.has(port)) return port
  }
  throw new NoFreeAdbPort(ADB_PORT_BASE, ADB_PORT_BASE + ADB_PORT_RANGE - 1)
}

const toDockerOptions = (
  spec: RedroidContainerSpec,
  adbPort: number
): Docker.ContainerCreateOptions => {
  const hostConfig: NonNullable<Docker.ContainerCreateOptions["HostConfig"]> = {
    // redroid 必须要,没有它基本起不来。
    Privileged: true,
    AutoRemove: spec.autoRemove,
    RestartPolicy: { Name: spec.restartPolicy },
    PortBindings: {
      // HostIp 必须写上。留空的话 Docker 按 0.0.0.0 处理 —— 那是 -p 5555:5555
      // 的行为,adb 会直接暴露在所有网卡上。
      [ADB_PORT_IN_CONTAINER]: [
        { HostIp: spec.adbBindAddress, HostPort: String(adbPort) },
      ],
    },
  }

  // /data 怎么挂。两种写法分开写,而不是用"靠源里有没有斜杠来猜是不是卷"
  // 那种省事的写法 —— 猜错了用户会得到一个卷,而他要的是宿主上的目录。
  if (spec.dataMount !== null) {
    if (spec.dataMount.kind === "bind") {
      hostConfig.Binds = [`${spec.dataMount.source}:/data`]
    } else {
      hostConfig.Mounts = [
        { Type: "volume", Source: spec.dataMount.name, Target: "/data" },
      ]
    }
  }

  return {
    name: spec.name,
    Image: spec.image,
    // redroid 是从容器的命令行里读这些参数的,形式就是 key=value。
    Cmd: spec.params.map((param) => `${param.name}=${param.value}`),
    // 打上标签,以后即使镜像被改名了,也认得出这是本程序建的容器。
    Labels: { [MANAGED_LABEL]: "true" },
    ExposedPorts: { [ADB_PORT_IN_CONTAINER]: {} },
    HostConfig: hostConfig,
  }
}

const request = async <A>(
  endpoint: DockerEndpoint,
  run: () => Promise<A>
): Promise<A> => {
  try {
    return await run()
  } catch (error) {
    throw translateDockerError(endpoint, error)
  }
}
