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
  readonly dataSource: string | null
  readonly params: ReadonlyArray<ContainerParam>
}

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

export const shortId = (id: string): string =>
  id.replace(/^sha256:/, "").slice(0, 12)

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
