import type Docker from "dockerode"
import { translateDockerError, type DockerEndpoint } from "./docker-host.js"

/**
 * redroid 官方镜像的列表,以及把其中一张拉到本机。
 *
 * 列表是问 Docker Hub 的公开接口要的 —— 官方就发布在那儿,本机没有任何
 * 地方能知道现在有哪些标签。这里只认 redroid/redroid 这一个仓库:页面上
 * 写的是"官方镜像",那它就不该顺手变成一个能拉任何东西的入口。
 *
 * 拉取本身交给 Docker daemon 做,这个模块只把它的进度流翻译成前端看得懂
 * 的形状 —— 一张镜像好几个 G,用户得知道现在拉到哪儿了。
 */

/** 官方仓库。列表和拉取都只认它。 */
export const OFFICIAL_REPOSITORY = "redroid/redroid"

/**
 * Hub 的标签接口。page_size 直接拉满:这个仓库一共一百来个标签,一次拿得完,
 * 而且 -latest 那些总是最新推上去的,必定在第一页里。
 */
const HUB_TAGS_URL = `https://hub.docker.com/v2/repositories/${OFFICIAL_REPOSITORY}/tags?page_size=100&ordering=last_updated`

/** 问 Hub 最多等多久。它慢的时候不该把页面一直卡在那儿。 */
const HUB_TIMEOUT_MS = 10_000

/**
 * Hub 的标签列表缓存多久算新鲜。
 *
 * 这个列表一天也变不了几次,而每进一次「镜像」页 / 每按一次刷新都会问
 * 一遍 Hub —— 不缓存的话页面要白等一个来回,还容易撞上限流。10 分钟
 * 足够让来回切页的人不再打网络,又不至于看到停更太久的东西。
 */
const HUB_CACHE_TTL_MS = 10 * 60_000

/** 进程内的那份缓存。重启后端就没了,这没问题 —— 它只是省一次网络往返。 */
let hubCache: {
  readonly tags: ReadonlyArray<HubTag>
  /** 拉回来的时刻(Date.now())。界面上的「更新于」就是它。 */
  readonly fetchedAt: number
} | null = null

/**
 * 官方推荐的标签形状:<Android 版本>[_64only]-latest。
 *
 * 仓库里还有一堆带日期戳的固定版本(14.0.0_64only-240527 这种),那是用来
 * 钉住某个老版本的,不是给普通用户挑的,列表里就不铺出来了。
 */
const LATEST_TAG = /^(\d+(?:\.\d+)*)(_64only)?-latest$/

/** 标签本身允许的字符,Docker 的规则。 */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface OfficialImage {
  /** 例:redroid/redroid:16.0.0_64only-latest */
  readonly reference: string
  /** 例:16.0.0 */
  readonly version: string
  /** 名字里带 _64only:只有 64 位运行库的精简版 */
  readonly only64: boolean
  /** 字节数,取的是**宿主机架构**那一份 */
  readonly size: number
  /** 这个标签发布了哪些架构 */
  readonly architectures: ReadonlyArray<string>
  /** Hub 上最后一次推送的时间 */
  readonly updatedAt: string
}

/** 官方镜像列表,加上"这份数据是什么时候、从哪儿来的"。 */
export interface OfficialImagesListing {
  readonly images: ReadonlyArray<OfficialImage>
  /** 这份列表从 Docker Hub 拉回来的时间(ISO)。命中的是缓存就是上次拉的时间。 */
  readonly fetchedAt: string
  /** 这次没打网络,直接给的缓存 */
  readonly cached: boolean
  /** Hub 现在连不上,给的是上一次的列表 */
  readonly stale: boolean
}

/**
 * 问不到 Docker Hub(断网、超时、被限流……)。
 *
 * 和 DockerFailure 一样自带"接下来怎么办",因为这两件事的对策完全不同:
 * 一个是"你的 Docker 有问题",一个是"这台机器上不了外网"。
 */
export class RegistryUnavailable extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = "RegistryUnavailable"
    this.hint = hint
  }
}

/** 想拉的不是官方仓库里的镜像。 */
export class NotAnOfficialImage extends Error {
  constructor() {
    super(`只能拉官方仓库 ${OFFICIAL_REPOSITORY} 里的镜像`)
    this.name = "NotAnOfficialImage"
  }
}

/** 拉取过程中 Docker 报错了(标签不存在、磁盘满了、被限流……)。 */
export class PullFailed extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(`拉取失败:${message}`)
    this.name = "PullFailed"
    this.hint = hint
  }
}

/**
 * 拉取过程中往外报的一行。
 *
 * layer 是某一层的进度 —— Docker 是一层一层(每个 blob)报的,界面上
 * 那几条进度条就是它;log 是没主的那些话,比如 "Pulling from ..."。
 */
export type PullProgress =
  | {
      readonly type: "layer"
      readonly id: string
      readonly status: string
      /** 这一层已经处理了多少字节;Docker 不知道的时候是 0 */
      readonly current: number
      /** 这一层一共多少字节;不知道的时候是 0 */
      readonly total: number
    }
  | { readonly type: "log"; readonly message: string }

/**
 * 官方镜像列表。
 *
 * 顺带问一次 daemon 的 CPU 架构:同一个标签在 Hub 上有 amd64 / arm64 好几份,
 * 大小不一样,列表上该显示这台机器真要下多少。
 */
export const listOfficialImages = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  options: { readonly refresh?: boolean } = {}
): Promise<OfficialImagesListing> => {
  const version = await request(endpoint, () => docker.version())
  const architecture = normalizeArchitecture(version.Arch ?? "")

  const cached = hubCache
  const fresh =
    cached !== null && Date.now() - cached.fetchedAt < HUB_CACHE_TTL_MS
  if (cached !== null && fresh && options.refresh !== true) {
    return listing(cached.tags, architecture, cached.fetchedAt, true, false)
  }

  try {
    const tags = await fetchHubTags()
    hubCache = { tags, fetchedAt: Date.now() }
    return listing(tags, architecture, hubCache.fetchedAt, false, false)
  } catch (error) {
    // Hub 连不上时,上次那份列表比一句报错有用:拉取本来就得等 Hub 恢复,
    // 但"外面现在有哪些版本"看看旧的一样能决定。第一次就没成功过的,
    // 还是照原样把错误抛出去。
    if (cached === null) throw error
    return listing(cached.tags, architecture, cached.fetchedAt, true, true)
  }
}

/**
 * 拉一张官方镜像,边拉边把进度报给调用者。返回拉的是哪个引用。
 *
 * 引用是从请求体里来的,所以要在这里收口:只允许官方仓库。不挡住的话,
 * 这个接口就成了"机器上能连通什么就能拉什么"的入口。
 */
export const pullOfficialImage = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  reference: unknown,
  onProgress: (progress: PullProgress) => void
): Promise<string> => {
  const wanted = officialReference(reference)
  onProgress({ type: "log", message: `开始拉取 ${wanted}` })

  const stream = await request(endpoint, () => docker.pull(wanted))
  await readPullStream(stream, onProgress)
  return wanted
}

/* ---------- 内部实现:Docker Hub 那半 ---------- */

/** 把 Hub 的标签整理成界面要的列表,顺带记上这份数据是什么时候拉回来的。 */
const listing = (
  tags: ReadonlyArray<HubTag>,
  architecture: string,
  fetchedAt: number,
  cached: boolean,
  stale: boolean
): OfficialImagesListing => ({
  images: tags
    .map((tag) => toOfficialImage(tag, architecture))
    .filter((image): image is OfficialImage => image !== null)
    .sort(compareImages),
  fetchedAt: new Date(fetchedAt).toISOString(),
  cached,
  stale,
})

/** Hub 上一个标签里我们关心的东西。 */
interface HubTag {
  readonly name: string
  readonly updatedAt: string
  readonly images: ReadonlyArray<{
    readonly architecture: string
    readonly size: number
  }>
}

const fetchHubTags = async (): Promise<ReadonlyArray<HubTag>> => {
  let response: Response
  try {
    response = await fetch(HUB_TAGS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    })
  } catch (error) {
    throw new RegistryUnavailable(
      `连不上 Docker Hub:${describeNetworkError(error)}`,
      "列官方镜像得能出网访问 hub.docker.com。拿不到这个列表不影响本机已有的镜像,也可以照旧用 docker pull 手动拉。"
    )
  }

  if (!response.ok) {
    throw new RegistryUnavailable(
      `Docker Hub 返回了 HTTP ${response.status}`,
      response.status === 429
        ? "请求被限流了 —— 过几分钟再刷新看看。"
        : "先确认这台机器能不能正常访问 hub.docker.com。"
    )
  }

  const body: unknown = await response.json().catch(() => null)
  const results = (body as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) {
    throw new RegistryUnavailable(
      "Docker Hub 的回复里没有标签列表",
      "过一会儿再刷新;要是它接口改了,这里得跟着改。"
    )
  }

  return results
    .map(parseHubTag)
    .filter((tag): tag is HubTag => tag !== null)
}

/** Hub 的 JSON 是外面的数据,缺字段、类型不对都当这条跳过。 */
const parseHubTag = (raw: unknown): HubTag | null => {
  if (typeof raw !== "object" || raw === null) return null
  const entry = raw as Record<string, unknown>

  const name = entry["name"]
  if (typeof name !== "string" || name === "") return null

  const images = Array.isArray(entry["images"]) ? entry["images"] : []
  return {
    name,
    updatedAt:
      typeof entry["last_updated"] === "string" ? entry["last_updated"] : "",
    images: images.flatMap((image) => {
      if (typeof image !== "object" || image === null) return []
      const candidate = image as Record<string, unknown>
      const architecture = candidate["architecture"]
      const size = candidate["size"]
      if (typeof architecture !== "string" || typeof size !== "number") return []
      return [{ architecture, size }]
    }),
  }
}

/** 一个 Hub 标签,能不能变成列表上的一行。 */
const toOfficialImage = (
  tag: HubTag,
  architecture: string
): OfficialImage | null => {
  const match = LATEST_TAG.exec(tag.name)
  if (match === null) return null

  return {
    reference: `${OFFICIAL_REPOSITORY}:${tag.name}`,
    version: match[1] ?? "",
    only64: match[2] === "_64only",
    size: sizeForArchitecture(tag.images, architecture),
    architectures: tag.images.map((image) => image.architecture),
    updatedAt: tag.updatedAt,
  }
}

/** 该显示多大的话,就拿宿主机架构那一份。 */
const sizeForArchitecture = (
  images: HubTag["images"],
  architecture: string
): number => {
  const exact = images.find((image) => image.architecture === architecture)
  if (exact !== undefined) return exact.size
  // 宿主机架构不在这个标签里(比如老标签只有 amd64):退回 amd64,再不行拿第一个。
  const fallback =
    images.find((image) => image.architecture === "amd64") ?? images[0]
  return fallback?.size ?? 0
}

/** Android 版本号大的排前面;同一版本里 64only 在前,现在的机器基本都用它。 */
const compareImages = (a: OfficialImage, b: OfficialImage): number =>
  compareVersions(b.version, a.version) || Number(b.only64) - Number(a.only64)

const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Docker 的 /version 给的架构名,和 Hub 上写的不完全是一套(x86_64 / aarch64
 * 这种是老写法)。两边对上号才能挑对大小。
 */
const normalizeArchitecture = (architecture: string): string => {
  const lower = architecture.trim().toLowerCase()
  if (lower === "x86_64" || lower === "x86-64" || lower === "amd64") {
    return "amd64"
  }
  if (lower === "aarch64" || lower === "arm64") return "arm64"
  if (lower === "armv7l" || lower === "armhf" || lower === "armv7") return "arm"
  return lower
}

const describeNetworkError = (error: unknown): string => {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return `等了 ${HUB_TIMEOUT_MS / 1000} 秒没有回应`
  }
  return error instanceof Error ? error.message : String(error)
}

/* ---------- 内部实现:拉取那半 ---------- */

const officialReference = (value: unknown): string => {
  if (typeof value !== "string") throw new NotAnOfficialImage()
  const separator = value.indexOf(":")
  const repository = separator < 0 ? value : value.slice(0, separator)
  const tag = separator < 0 ? "" : value.slice(separator + 1)
  if (repository !== OFFICIAL_REPOSITORY || !TAG.test(tag)) {
    throw new NotAnOfficialImage()
  }
  return value
}

/** Docker 拉取时吐出来的事件。只挑我们用得到的字段。 */
interface PullEvent {
  readonly status?: string
  readonly id?: string
  readonly progressDetail?: {
    readonly current?: number
    readonly total?: number
  }
  readonly error?: string
  readonly errorDetail?: { readonly message?: string }
}

// 拉取的响应和构建一样,是一串 JSON 一行一个(不是一次给完整个响应),所以
// 得自己攒着按行切:一个网络分片可能只包含半行。
const readPullStream = async (
  stream: NodeJS.ReadableStream,
  onProgress: (progress: PullProgress) => void
): Promise<void> => {
  const handleLine = (line: string) => {
    const text = line.trim()
    if (text === "") return

    let event: PullEvent
    try {
      event = JSON.parse(text) as PullEvent
    } catch {
      // 解析不了就原样报出去,总比吞掉强
      onProgress({ type: "log", message: text })
      return
    }

    const failure = event.errorDetail?.message ?? event.error
    if (typeof failure === "string" && failure.trim() !== "") {
      throw new PullFailed(failure.trim(), pullFailureHint(failure))
    }
    if (typeof event.status !== "string") return

    // "Pulling from <仓库>" 这行也带 id,但它的 id 是标签名,不是层 ——
    // 当成一层的话进度条上会多出一条永远 0% 的假层。
    if (event.status.startsWith("Pulling from")) {
      onProgress({ type: "log", message: event.status })
      return
    }

    if (typeof event.id === "string" && event.id !== "") {
      onProgress({
        type: "layer",
        id: event.id,
        status: event.status,
        current: positive(event.progressDetail?.current),
        total: positive(event.progressDetail?.total),
      })
      return
    }

    onProgress({ type: "log", message: event.status })
  }

  let buffered = ""
  for await (const chunk of stream) {
    buffered += String(chunk)
    let index = buffered.indexOf("\n")
    while (index >= 0) {
      handleLine(buffered.slice(0, index))
      buffered = buffered.slice(index + 1)
      index = buffered.indexOf("\n")
    }
  }
  handleLine(buffered)
}

/** Docker 只给一句英文,常见的那几种替它把"该怎么办"补上。 */
const pullFailureHint = (message: string): string => {
  if (/no such (image|host)|not found|manifest unknown/i.test(message)) {
    return "这个标签在 Hub 上没有了,刷新一下列表重新挑一个。"
  }
  if (/toomanyrequests|rate limit/i.test(message)) {
    return "被 Docker Hub 限流了。等一会儿再试,或者先 docker login 提高额度。"
  }
  if (/no space left/i.test(message)) {
    return "本机磁盘满了,先清点空间再拉。"
  }
  return ""
}

const positive = (value: number | undefined): number =>
  typeof value === "number" && value > 0 ? value : 0

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
