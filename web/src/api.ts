// 这里定义的类型要和后端 src/images.ts、src/containers.ts、src/redroid-params.ts
// 保持一致。现在是两边各写一份(改的时候记得两边都改);等接口多起来,
// 可以抽成一个共享包给前后端一起用,但现在还不到时候。

export type ImageKind = "official" | "derived"

export interface RedroidImage {
  readonly reference: string
  readonly id: string
  readonly architecture: string
  readonly size: number
  readonly kind: ImageKind
}

export interface RedroidParameter {
  readonly name: string
  readonly summary: string
  readonly defaultValue?: string
  readonly allowedValues?: ReadonlyArray<string>
  readonly pattern?: string
}

export interface ContainerParam {
  readonly name: string
  readonly value: string
  readonly parameter: RedroidParameter | null
}

export interface RedroidContainer {
  readonly id: string
  readonly name: string
  readonly image: string
  readonly state: string
  readonly status: string
  readonly createdAt: string
  readonly restartPolicy: string
  readonly privileged: boolean
  readonly autoRemove: boolean
  readonly adbPort: number | null
  /**
   * adb 端口绑在宿主的哪个地址上。null 表示压根没映射端口。
   * "0.0.0.0" 是"所有网卡"—— 也就是局域网上谁都能连,界面上要标出来。
   */
  readonly adbBindAddress: string | null
  readonly dataMount: DataMount | null
  readonly params: ReadonlyArray<ContainerParam>
}

// /data 挂到哪儿了。命名卷和宿主目录分开表达,界面才好分别显示
// —— 卷要显示名字,不能显示 Docker 内部那个 /var/lib/docker/volumes/... 路径。
export type DataMount =
  | { readonly kind: "bind"; readonly source: string }
  | { readonly kind: "volume"; readonly name: string }

export const dataMountLabel = (mount: DataMount): string =>
  mount.kind === "volume" ? `卷 ${mount.name}` : mount.source

/**
 * adb 端口绑在宿主的哪个地址上。
 *
 * 默认只有本机:adb 没有鉴权,连上就是 Android 里的 root,绑到所有网卡等于
 * 把它敞开在网络上。要远程连的时候再显式打开。
 */
export type AdbBindAddress = "127.0.0.1" | "0.0.0.0"

/** 这个绑定地址是不是"对全网开放"。 */
export const isAdbExposed = (address: string | null): boolean =>
  address === "0.0.0.0" || address === "::"

/** 该用哪个地址去 adb connect。绑在所有网卡上时,本机连 localhost 就行。 */
export const adbConnectHost = (address: string | null): string =>
  address === null || isAdbExposed(address) ? "localhost" : address

// 后端返回的错误:message 是一句话,hint 是该怎么办。
export class ApiFailure extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = "ApiFailure"
    this.hint = hint
  }
}

const OFFLINE_MESSAGE = "连不上后端"
const OFFLINE_HINT =
  "确认后端还在跑 —— 终端里应该有「✓ 后端已启动」那一行。"

// 把"请求失败"统一翻译成 ApiFailure。三种失败长得很不一样:
//   后端自己回的(带 message/hint)、Vite 代理转发失败(502/504)、
//   fetch 直接抛(后端进程都没了),但给用户看的应该是同一套话。
const failureOf = async (response: Response): Promise<ApiFailure> => {
  const body: unknown = await response.json().catch(() => null)
  const detail = body as { message?: unknown; hint?: unknown } | null

  if (typeof detail?.message === "string") {
    return new ApiFailure(
      detail.message,
      typeof detail.hint === "string" ? detail.hint : ""
    )
  }
  if (response.status === 502 || response.status === 504) {
    return new ApiFailure(OFFLINE_MESSAGE, OFFLINE_HINT)
  }
  return new ApiFailure(`后端返回了 HTTP ${response.status}`, "")
}

const getJson = async (path: string): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(path)
  } catch {
    // fetch 在这一步失败,通常是后端根本没在跑(而不是后端返回了错误)
    throw new ApiFailure(OFFLINE_MESSAGE, OFFLINE_HINT)
  }

  if (!response.ok) throw await failureOf(response)

  return await response.json().catch(() => null)
}

const send = async (
  method: "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    })
  } catch {
    throw new ApiFailure(OFFLINE_MESSAGE, OFFLINE_HINT)
  }
  if (!response.ok) throw await failureOf(response)
  return await response.json().catch(() => null)
}

/** 能直接拿来起容器的镜像(原版 + 程序造的派生镜像)。 */
export const fetchUsableImages = async (): Promise<
  ReadonlyArray<RedroidImage>
> => {
  const body = (await getJson("/api/images/usable")) as {
    images?: ReadonlyArray<RedroidImage>
  }
  return body.images ?? []
}

/** 只能拿来当基础继续叠层的那部分(纯原版)。合成台用这个。 */
export const fetchBaseImages = async (): Promise<
  ReadonlyArray<RedroidImage>
> => {
  const body = (await getJson("/api/images/base")) as {
    images?: ReadonlyArray<RedroidImage>
  }
  return body.images ?? []
}

/**
 * Docker Hub 上 redroid 官方仓库的标签列表。后端要出网才拿得到,
 * 拿不到会回一句人话(503),前端照常显示错误框。
 */
export const fetchOfficialImages = async (): Promise<
  ReadonlyArray<OfficialImage>
> => {
  const body = (await getJson("/api/images/official")) as {
    images?: ReadonlyArray<OfficialImage>
  }
  return body.images ?? []
}

export interface OfficialImage {
  /** 例:redroid/redroid:16.0.0_64only-latest */
  readonly reference: string
  /** 例:16.0.0 */
  readonly version: string
  /** 名字里带 _64only:只有 64 位运行库的精简版 */
  readonly only64: boolean
  /** 字节数,后端挑的是宿主机架构那一份 */
  readonly size: number
  readonly architectures: ReadonlyArray<string>
  readonly updatedAt: string
}

/**
 * 从本机删掉一张镜像。传的是标签那种引用(redroid/redroid:xxx),引用里有
 * `/` 和 `:`,所以整段要编码后再塞进路径。
 *
 * 还有容器在用这张镜像时后端会回 409 —— 那是"先删容器"的信号,不是出错。
 */
export const removeImage = (reference: string): Promise<void> =>
  send("DELETE", `/api/images/${encodeURIComponent(reference)}`).then(
    () => undefined
  )

export const fetchContainers = async (): Promise<
  ReadonlyArray<RedroidContainer>
> => {
  const body = (await getJson("/api/containers")) as {
    containers?: ReadonlyArray<RedroidContainer>
  }
  return body.containers ?? []
}

export const startContainer = (id: string): Promise<void> =>
  send("POST", `/api/containers/${encodeURIComponent(id)}/start`).then(
    () => undefined
  )

export const stopContainer = (id: string): Promise<void> =>
  send("POST", `/api/containers/${encodeURIComponent(id)}/stop`).then(
    () => undefined
  )

export const removeContainer = (id: string): Promise<void> =>
  send("DELETE", `/api/containers/${encodeURIComponent(id)}`).then(() => undefined)

/**
 * 容器里那台 Android 的握手信息。
 *
 * 浏览器自己连不到 adbd,这些东西(单包上限、有哪些 feature)只能由后端
 * 在握手时问出来再转告 —— 前端要靠它才能造出一个 Adb 实例。
 * 字段可能缺,因为 JSON 里 undefined 会整个消失。
 */
export interface AdbDeviceInfo {
  readonly serial: string
  readonly maxPayloadSize: number
  readonly clientFeatures: ReadonlyArray<string>
  readonly banner: {
    readonly product?: string
    readonly model?: string
    readonly device?: string
    readonly features: ReadonlyArray<string>
  }
}

export const fetchAdbInfo = (id: string): Promise<AdbDeviceInfo> =>
  getJson(
    `/api/containers/${encodeURIComponent(id)}/adb`
  ) as Promise<AdbDeviceInfo>

/** redroid 官方文档里的参数表。创建表单是照着它生成的。 */
export const fetchRedroidParams = async (): Promise<
  ReadonlyArray<RedroidParameter>
> => {
  const body = (await getJson("/api/redroid-params")) as {
    parameters?: ReadonlyArray<RedroidParameter>
  }
  return body.parameters ?? []
}

/**
 * /data 怎么挂。后端两种都用 `source` 收:kind 是 bind 时它是宿主目录的
 * 绝对路径,是 volume 时它是卷名。
 */
export interface DataMountInput {
  readonly kind: "bind" | "volume"
  readonly source: string
}

export interface CreateContainerInput {
  readonly image: string
  readonly name: string
  readonly autoRemove: boolean
  readonly restartPolicy: string
  readonly dataMount: DataMountInput | null
  readonly params: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /** 宿主端口 -> 容器里的 5555;null 表示让后端自动挑一个 */
  readonly adbPort: number | null
  /** 上面那个端口绑在宿主的哪个地址上 */
  readonly adbBindAddress: AdbBindAddress
}

export interface CreatedContainer {
  readonly name: string
  readonly adbPort: number
}

export const createContainer = async (
  input: CreateContainerInput
): Promise<CreatedContainer> =>
  (await send("POST", "/api/containers", input)) as CreatedContainer

export const formatSize = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`

export const stateLabel = (state: string): string =>
  state === "running"
    ? "运行中"
    : state === "exited"
      ? "已退出"
      : state === "created"
        ? "已创建,未启动"
        : state === "paused"
          ? "已暂停"
          : state === "restarting"
            ? "重启中"
            : state

// 合成台推进来的一行。后端是边构建边往响应里写这些的。
export interface ComposeEvent {
  readonly type: "log" | "done" | "error"
  readonly message?: string
  readonly hint?: string
  readonly target?: string
  readonly imageId?: string | null
}

/**
 * 拉镜像时后端推回来的一行。
 *
 * layer 是某一层(blob)的进度 —— Docker 是一层一层报的,界面上那几条进度
 * 条就是它;log 是没主的那些话。
 */
export interface PullEvent {
  readonly type: "layer" | "log" | "done" | "error"
  readonly id?: string
  readonly status?: string
  readonly current?: number
  readonly total?: number
  readonly message?: string
  readonly hint?: string
  readonly reference?: string
}

// 后端那几个「边跑边推」的接口(合成镜像、拉镜像)形状是一样的:POST 出去,
// 响应是一串 NDJSON,一行一个 JSON。所以发请求和按行切开只写一份。
//
// 这里不用 fetch().json(),因为响应是**流**:整个过程会持续往里写,前端要
// 边收边显示。普通 fetch 会把响应读完才返回,那样进度就变成结束之后一次性
// 冒出来了。
const openStream = async (
  path: string,
  body: BodyInit,
  headers?: Record<string, string>
): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(path, {
      method: "POST",
      ...(headers === undefined ? {} : { headers }),
      body,
    })
  } catch {
    throw new ApiFailure(OFFLINE_MESSAGE, OFFLINE_HINT)
  }
  if (!response.ok) throw await failureOf(response)
  return response
}

const readStream = async <E extends { readonly type: string }>(
  response: Response,
  onEvent: (event: E) => void
): Promise<void> => {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    throw new ApiFailure("这个浏览器读不了流式响应", "换一个现代浏览器试试。")
  }

  const decoder = new TextDecoder()
  let buffered = ""

  const emit = (line: string) => {
    const text = line.trim()
    if (text === "") return
    try {
      onEvent(JSON.parse(text) as E)
    } catch {
      // 解析不了就原样当一行日志 —— 两个接口的 log 事件都是这个形状。
      onEvent({ type: "log", message: text } as unknown as E)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    let index = buffered.indexOf("\n")
    while (index >= 0) {
      emit(buffered.slice(0, index))
      buffered = buffered.slice(index + 1)
      index = buffered.indexOf("\n")
    }
  }
  emit(buffered)
}

/** 把合成请求发出去,并把后端边跑边推过来的行交给 onEvent。 */
export const composeImage = async (
  form: FormData,
  onEvent: (event: ComposeEvent) => void
): Promise<void> => {
  const response = await openStream("/api/compose", form)
  await readStream<ComposeEvent>(response, onEvent)
}

/**
 * 拉一张官方镜像,边拉边把进度交给 onEvent。
 *
 * 拉几个 G 要好几分钟,所以这一步也是流式的:后端一直在往外推,前端才有
 * 进度条可看。拉完(或者出错)才 resolve。
 */
export const pullOfficialImage = async (
  reference: string,
  onEvent: (event: PullEvent) => void
): Promise<void> => {
  const response = await openStream(
    "/api/images/pull",
    JSON.stringify({ reference }),
    { "Content-Type": "application/json" }
  )
  await readStream<PullEvent>(response, onEvent)
}
