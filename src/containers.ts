import type Docker from "dockerode"
import {
  statusCodeOf,
  translateDockerError,
  type DockerEndpoint,
} from "./docker-host.js"
import { MANAGED_LABEL } from "./labels.js"
import {
  findRedroidParameter,
  type BootParam,
  type RedroidParameter,
} from "./redroid-params.js"

/**
 * 列出这台 Docker 上已经创建的 redroid 容器。
 *
 * "是不是 redroid 容器"**不看镜像是不是原版**,满足任意一条就算:
 *   1. 镜像的仓库名正好是 redroid(名字里带上 redroid 的不算,否则本程序
 *      自己的 redroid-web-manager 镜像会被当成安卓容器)
 *   2. 命令行里带了 androidboot.* 或 ro.* 参数(只有 redroid 会这么传)
 *
 * 对外只有一个函数。底下藏的是调用者不该操心的东西:Docker 那几种别扭的
 * JSON 结构(端口绑定、重启策略、挂载点)、参数解析、以及上面这两条判据。
 * 这些解析都是纯函数,可以脱离 Docker 单独验证。
 */

/** 容器上设的一个 redroid 启动参数,外加它在文档里的定义。 */
export interface ContainerParam extends BootParam {
  /** 官方文档里的定义;null 表示文档里没有,可能是自定义的 */
  readonly parameter: RedroidParameter | null
}

/**
 * /data 挂到哪儿了。
 *
 * 两种形态分开表达,因为它们在 Docker 的 inspect 里长得很不一样:命名卷同时
 * 带 Name(卷名)和一个 Source(宿主上的内部路径),宿主目录只有一个 Source。
 * 混成一个字符串的话,显示卷的时候就会露出 /var/lib/docker/volumes/... 那种
 * 对用户毫无意义的路径。
 *
 * 创建容器那边也用这个类型,读写两侧同一套词汇。
 */
export type DataMount =
  | { readonly kind: "bind"; readonly source: string }
  | { readonly kind: "volume"; readonly name: string }

export interface RedroidContainer {
  readonly id: string
  readonly name: string
  readonly image: string
  /** Docker 的状态:running / exited / created … */
  readonly state: string
  /** Docker 给的那句人话,例如 "Up 3 hours" */
  readonly status: string
  readonly createdAt: string
  /** 重启策略:"no" / "always" / "unless-stopped" / "on-failure:3" */
  readonly restartPolicy: string
  /** redroid 必须加 --privileged,没加基本起不来 */
  readonly privileged: boolean
  /**
   * 容器是不是用 --rm 起的。redroid 官方文档给的命令里就有 --rm,
   * 所以这个很常见。带 --rm 的容器一旦停止就会被 Docker 自动删掉,
   * 界面上必须提醒 —— 否则用户以为只是"停一下",结果是"删掉了"。
   */
  readonly autoRemove: boolean
  /** 宿主端口 -> 容器里的 5555(adb);没映射就是 null */
  readonly adbPort: number | null
  /**
   * 上面那个端口绑在宿主哪个地址上。
   *
   * 老容器(这个程序还没管绑定地址时建的)会是 "0.0.0.0" —— Docker 对空
   * HostIp 就是这个意思。界面上要把它标出来:adb 没鉴权,那就是对全网开着。
   */
  readonly adbBindAddress: string | null
  /** /data 挂到哪儿了;没挂就是 null(不挂的话容器一删数据就没了) */
  readonly dataMount: DataMount | null
  /** 命令行里带的 redroid 参数 */
  readonly params: ReadonlyArray<ContainerParam>
}

/**
 * 这个 id 指不到任何本模块管的容器。
 * 调用者不需要知道"什么算 redroid 容器"——那是这个模块的事。
 */
export class ContainerNotFound extends Error {
  readonly id: string

  constructor(id: string) {
    super(`没有这个 redroid 容器:${id}`)
    this.name = "ContainerNotFound"
    this.id = id
  }
}

/** 容器存在,但它不是 redroid 容器,所以不归这里管。 */
export class NotARedroidContainer extends Error {
  readonly id: string
  readonly image: string

  constructor(id: string, image: string) {
    super(`${id} 用的镜像不像是 redroid(${image})`)
    this.name = "NotARedroidContainer"
    this.id = id
    this.image = image
  }
}

/**
 * 容器没把 5555 发布到宿主上,后端就够不着它的 adb。
 *
 * 这是建容器时能选的:端口留空就不映射。改了得重建容器(Docker 不支持给
 * 已经建好的容器加端口映射),所以提示里要说清楚这一点。
 */
export class AdbPortNotPublished extends Error {
  readonly id: string

  constructor(id: string) {
    super(`${id} 没有把 adb 端口(5555)发布到宿主上`)
    this.name = "AdbPortNotPublished"
    this.id = id
  }
}

/** 容器没在跑。映射关系还在,但没人在那个端口上听。 */
export class ContainerNotRunning extends Error {
  readonly id: string
  readonly state: string

  constructor(id: string, state: string) {
    super(`${id} 现在是 ${state} 状态,没在跑`)
    this.name = "ContainerNotRunning"
    this.id = id
    this.state = state
  }
}

/**
 * 容器的 adb 在宿主的哪儿。port 是宿主上的端口,bindAddress 是它绑在宿主
 * 哪个地址上(0.0.0.0 表示所有网卡)。
 *
 * 只回答"Docker 说它映射到哪儿",不管"该怎么连" —— 从哪台机器去连、用
 * 127.0.0.1 还是别的地址,那是调用者的事(见 adb/sessions.ts)。
 */
export interface RedroidAdbPort {
  readonly port: number
  readonly bindAddress: string | null
}

export const findRedroidAdbPort = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  id: string
): Promise<RedroidAdbPort> => {
  const container = await findRedroidContainer(docker, endpoint, id)

  const state = container.State?.Status ?? "unknown"
  if (state !== "running") throw new ContainerNotRunning(id, state)

  const port = adbPortOf(container.NetworkSettings, container.HostConfig)
  if (port === null) throw new AdbPortNotPublished(id)

  return {
    port,
    bindAddress: adbBindAddressOf(
      container.NetworkSettings,
      container.HostConfig
    ),
  }
}

export const listRedroidContainers = async (
  docker: Docker,
  endpoint: DockerEndpoint
): Promise<ReadonlyArray<RedroidContainer>> => {
  const summaries = await request(endpoint, () =>
    docker.listContainers({ all: true })
  )

  const containers: RedroidContainer[] = []
  for (const summary of summaries) {
    // 命令行参数只有 inspect 才知道,所以每个容器都得看一遍。
    // 容器数量不会多,这点开销无所谓。
    const inspect = await request(endpoint, () =>
      docker.getContainer(summary.Id).inspect()
    )

    const params = parseBootParams(inspect.Config?.Cmd ?? [])
    if (!isRedroidContainer(summary.Image, params, inspect.Config?.Labels)) continue

    containers.push({
      id: inspect.Id,
      name: (inspect.Name ?? summary.Names[0] ?? "").replace(/^\//, ""),
      image: inspect.Config?.Image ?? summary.Image,
      state: inspect.State?.Status ?? summary.State,
      status: summary.Status,
      createdAt: inspect.Created,
      restartPolicy: restartPolicyOf(inspect.HostConfig),
      privileged: inspect.HostConfig?.Privileged === true,
      autoRemove: inspect.HostConfig?.AutoRemove === true,
      adbPort: adbPortOf(inspect.NetworkSettings, inspect.HostConfig),
      adbBindAddress: adbBindAddressOf(
        inspect.NetworkSettings,
        inspect.HostConfig
      ),
      dataMount: dataMountOf(inspect.Mounts),
      params,
    })
  }

  return containers.sort((a, b) => a.name.localeCompare(b.name))
}

// 启动一个容器。已经在跑就什么都不做 —— 想要的状态已经达成了,不该报错。
export const startRedroidContainer = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  id: string
): Promise<void> => {
  const container = await findRedroidContainer(docker, endpoint, id)
  if (container.State?.Status === "running") return
  await request(endpoint, () =>
    ignoringNotModified(() => docker.getContainer(id).start())
  )
}

// 停止一个容器。已经停了就什么都不做。
export const stopRedroidContainer = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  id: string
): Promise<void> => {
  const container = await findRedroidContainer(docker, endpoint, id)
  await stopIfRunning(docker, endpoint, id, container)
}

// 删掉一个容器。
//
// 调用者不需要知道"Docker 不允许删正在运行的容器"这条规矩 —— 实测直接删会
// 返回 409,而且容器还在。这里先停再删。
//
// 为什么不用 force 一把删掉:force 是直接 SIGKILL,对 Android 的 /data 分区
// 不好。先停是给容器一个正常关机的机会。
//
// 另外注意:容器删了,它挂出来的 /data 目录还留在宿主机上。数据要不要一起删
// 是另一件事,这个模块不管。
export const removeRedroidContainer = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  id: string
): Promise<void> => {
  const container = await findRedroidContainer(docker, endpoint, id)
  await stopIfRunning(docker, endpoint, id, container)
  // --rm 的容器在停止的时候已经被 Docker 删掉了,不用(也来不及)再删一次:
  // 再发一次删除会撞上它的自动删除,得到 409。既然它已经没了,这里就是做完了。
  if (removesItselfWhenStopped(container)) return
  await request(endpoint, () => docker.getContainer(id).remove())
}

/* ---------- 内部实现:全是纯函数,吃 Docker 的 JSON,吐干净的结果 ---------- */

// 停止时给容器多少秒优雅退出的机会,超时 Docker 会直接 SIGKILL。
// 10 是 Docker 自己的默认值。调大意味着"停容器"这个操作要等更久,
// 调小则可能在 Android 还没写完 /data 的时候就把它杀掉。
const STOP_TIMEOUT_SECONDS = 10

// 容器 id 或名字允许的字符,Docker 自己也用这个规则。
//
// 多这一道检查是因为 id 是从 URL 里拿的,会被拼进请求路径 —— 不挡住的话,
// 一个带斜杠的字符串就可能指到别的 Docker 接口上去。
const CONTAINER_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

// 找到容器,并确认它归这个模块管。
//
// 这是模块的不变量:这个模块的世界里只有 redroid 容器,别的容器一律当
// "不存在"。这样 HTTP 层就不可能因为写错或者是恶意请求,顺手把 code-server
// 之类的容器停掉、删掉。
const findRedroidContainer = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  id: string
) => {
  if (!CONTAINER_REFERENCE.test(id)) throw new ContainerNotFound(id)

  let inspect
  try {
    inspect = await docker.getContainer(id).inspect()
  } catch (error) {
    // 404 在这里的语义是"没这个容器",不是"对面不是 Docker"——
    // 状态码的含义跟接口有关,所以要在这里先判断掉。
    if (statusCodeOf(error) === 404) throw new ContainerNotFound(id)
    throw translateDockerError(endpoint, error)
  }

  const image = inspect.Config?.Image ?? ""
  const params = parseBootParams(inspect.Config?.Cmd ?? [])
  if (!isRedroidContainer(image, params, inspect.Config?.Labels)) {
    throw new NotARedroidContainer(id, image)
  }

  return inspect
}

const stopIfRunning = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  id: string,
  container: { readonly State?: { readonly Status?: string } }
): Promise<void> => {
  if (container.State?.Status !== "running") return
  await request(endpoint, () =>
    ignoringNotModified(() =>
      docker.getContainer(id).stop({ t: STOP_TIMEOUT_SECONDS })
    )
  )
}

// Docker 把"已经在跑了""已经停了"当成 304 报错返回。
// 对我们来说那不是错误 —— 想要的状态已经达成了。
const ignoringNotModified = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    if (statusCodeOf(error) !== 304) throw error
  }
}

// 这个容器会不会在被停止的时候把自己删掉(--rm 起的容器会)。
//
// 只看"正在跑"的情况:没在跑的 --rm 容器不会被自动删(比如只 create 过、
// 从没 start 的),那种还是得老老实实调一次删除。
const removesItselfWhenStopped = (container: {
  readonly State?: { readonly Status?: string }
  readonly HostConfig?: { readonly AutoRemove?: boolean }
}): boolean =>
  container.HostConfig?.AutoRemove === true &&
  container.State?.Status === "running"

/**
 * redroid 从容器的命令行里读参数,形式是 key=value。
 * 只挑它认的那些:androidboot.* 和 ro.*(文档里说 ro.* 是调试用的)。
 */
const parseBootParams = (
  command: ReadonlyArray<string>
): ReadonlyArray<ContainerParam> => {
  const params: ContainerParam[] = []
  for (const argument of command) {
    const separator = argument.indexOf("=")
    if (separator <= 0) continue
    const name = argument.slice(0, separator)
    if (!name.startsWith("androidboot.") && !name.startsWith("ro.")) continue
    params.push({
      name,
      value: argument.slice(separator + 1),
      parameter: findRedroidParameter(name) ?? null,
    })
  }
  return params
}

const isRedroidContainer = (
  image: string,
  params: ReadonlyArray<ContainerParam>,
  labels: Readonly<Record<string, string>> | undefined
): boolean =>
  // 本程序创建的容器一定带这个标签 —— 这是最准的一条,即使镜像被重新打了
  // 一个跟 redroid 无关的名字也认得出来。
  labels?.[MANAGED_LABEL] === "true" ||
  isRedroidImageName(image) ||
  params.length > 0

/**
 * 镜像引用的仓库名是不是 redroid —— 形状是 [地址/]命名空间/名字[:标签][@摘要],
 * 只取最后一段并切掉标签。别的仓库也发布 redroid,所以不能只认 redroid/redroid。
 */
const isRedroidImageName = (reference: string): boolean => {
  const [withoutDigest = ""] = reference.split("@")
  const repository = withoutDigest.split("/").pop() ?? ""
  const separator = repository.indexOf(":")
  const name =
    separator === -1 ? repository : repository.slice(0, separator)
  return name === "redroid"
}

/**
 * 找宿主上映射到 5555(adb)的端口。
 *
 * 两个地方都要看,这是 Docker 的一个坑:
 *   NetworkSettings.Ports    实际绑定,**只有容器跑起来之后**才有值
 *   HostConfig.PortBindings  想要绑到哪里,创建容器时就有了
 *
 * 只看前者的话,"创建了但没启动"的容器会显示成"没有映射"——那是错的。
 * 这里的结构长这样:{"5555/tcp": [{HostIp: "0.0.0.0", HostPort: "5555"}]}。
 */
const adbPortOf = (
  networkSettings:
    | {
        readonly Ports?: Readonly<
          Record<string, ReadonlyArray<{ HostPort: string }> | null>
        >
      }
    | undefined,
  hostConfig:
    | {
        readonly PortBindings?: Readonly<
          Record<string, ReadonlyArray<{ HostPort?: string }> | null>
        >
      }
    | undefined
): number | null => {
  const actual = networkSettings?.Ports?.["5555/tcp"]?.[0]?.HostPort
  const requested = hostConfig?.PortBindings?.["5555/tcp"]?.[0]?.HostPort
  return parsePort(actual) ?? parsePort(requested)
}

/**
 * adb 端口绑在宿主的哪个地址上。
 *
 * 同样两个地方都要看(理由见上面),并且要把 Docker 的几种"没写"翻译成
 * 它实际的语义:HostIp 是空字符串(或 IPv6 的 "::")时,Docker 绑的是所有
 * 网卡 —— 直接显示成空字符串,用户看不出这是"对全网开放"。
 */
const adbBindAddressOf = (
  networkSettings:
    | {
        readonly Ports?: Readonly<
          Record<string, ReadonlyArray<{ HostIp?: string }> | null>
        >
      }
    | undefined,
  hostConfig:
    | {
        readonly PortBindings?: Readonly<
          Record<string, ReadonlyArray<{ HostIp?: string }> | null>
        >
      }
    | undefined
): string | null => {
  const actual = networkSettings?.Ports?.["5555/tcp"]?.[0]?.HostIp
  const requested = hostConfig?.PortBindings?.["5555/tcp"]?.[0]?.HostIp
  const raw = actual ?? requested
  if (raw === undefined) return null

  const trimmed = raw.trim()
  if (trimmed === "" || trimmed === "::") return "0.0.0.0"
  // ::ffff:127.0.0.1 这种 IPv4-mapped 形式,Docker 有时会这么报。
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed
}

const parsePort = (value: string | undefined): number | null => {
  if (value === undefined || value === "") return null
  const port = Number(value)
  return Number.isInteger(port) ? port : null
}

/** 重启策略藏在 HostConfig 里,on-failure 还会带一个重试次数。 */
const restartPolicyOf = (
  hostConfig:
    | {
        readonly RestartPolicy?:
          | { readonly Name?: string; readonly MaximumRetryCount?: number }
          | undefined
      }
    | undefined
): string => {
  const policy = hostConfig?.RestartPolicy
  const name = policy?.Name ?? "no"
  const retries = policy?.MaximumRetryCount ?? 0
  return name === "on-failure" && retries > 0 ? `${name}:${retries}` : name
}

/**
 * 官方推荐的 -v ~/data:/data,不挂的话容器一删数据就没了。
 *
 * 命名卷要显示**名字**而不是 Source —— 后者是 Docker 在宿主机上放卷数据的
 * 内部路径(/var/lib/docker/volumes/<名字>/_data),用户拿它没用,而且看着
 * 像是个真目录,容易误会。
 */
const dataMountOf = (
  mounts:
    | ReadonlyArray<{
        readonly Type?: string
        readonly Destination?: string
        readonly Source?: string
        readonly Name?: string
      }>
    | undefined
): DataMount | null => {
  const mount = mounts?.find((candidate) => candidate.Destination === "/data")
  if (mount === undefined) return null

  if (mount.Type === "volume" && mount.Name !== undefined && mount.Name !== "") {
    return { kind: "volume", name: mount.Name }
  }
  // 其余情况(宿主目录,以及少见的 tmpfs 之类)都按路径显示。
  if (mount.Source !== undefined && mount.Source !== "") {
    return { kind: "bind", source: mount.Source }
  }
  return null
}

/** 跑一个 dockerode 调用,失败就把错误翻译成人话再抛出去。 */
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
