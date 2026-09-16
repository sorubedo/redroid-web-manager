import type Docker from "dockerode"
import tar from "tar-stream"
import {
  translateDockerError,
  type DockerEndpoint,
} from "./docker-host.js"
import { MANAGED_LABEL } from "./labels.js"

// 镜像合成台:拿一张原版 redroid 镜像,叠上一个或多个 tar 包,产出一张新镜像。
//
// 这里**不知道 tar 包里是什么**,也不需要知道 —— Magisk 只是最初的那个用例。
// 程序只做两件事:把 tar 拼成 Docker 构建上下文,交给 Docker 去构建。
//
// 和 Rust 版 redroid-helper 的关系:那边 build_context() 生成一个内存里的
// tar,再 POST 到 /build。这里是同一套做法,只是从"一个固定叫 magisk-layer.tar
// 的层"变成"用户上传的任意多个 tar"。

export interface ComposeLayer {
  /** 上传时的文件名,只用来记日志和给上下文里的文件起名 */
  readonly name: string
  readonly content: Uint8Array
}

export interface ComposeSpec {
  readonly base: string
  readonly target: string
  readonly layers: ReadonlyArray<ComposeLayer>
}

export interface ComposeResult {
  readonly target: string
  /** Docker 构建完给的新镜像 ID;没拿到就是 null */
  readonly imageId: string | null
}

/** 传进来的东西不合法。带上哪个字段不对,方便界面指出位置。 */
export class InvalidComposeSpec extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = "InvalidComposeSpec"
    this.field = field
  }
}

/** Docker 构建失败了(比如 Dockerfile 有问题、层里的文件写不进去)。 */
export class ComposeFailed extends Error {
  constructor(message: string) {
    super(`构建失败:${message}`)
    this.name = "ComposeFailed"
  }
}

export const composeImage = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  spec: ComposeSpec,
  onProgress: (message: string) => void
): Promise<ComposeResult> => {
  validateSpec(spec)

  const contextNames = spec.layers.map((layer, index) =>
    contextNameFor(layer.name, index)
  )

  onProgress(`基础镜像:${spec.base}`)
  onProgress(`输出标签:${spec.target}`)
  spec.layers.forEach((layer, index) => {
    onProgress(
      `第 ${index + 1} 层:${layer.name}(${inMegabytes(layer.content.byteLength)})→ ${contextNames[index]}`
    )
  })

  const context = await buildContext(spec, contextNames)
  onProgress(`构建上下文拼好了,共 ${inMegabytes(context.byteLength)}`)

  try {
    return await runBuild(docker, spec, context, onProgress)
  } catch (error) {
    if (error instanceof ComposeFailed) throw error
    throw translateDockerError(endpoint, error)
  }
}

/* ---------- 内部实现 ---------- */

// 镜像引用允许的字符。
//
// 这道检查是**防注入用的**:base 会被写进 Dockerfile 的 FROM 和 LABEL,
// target 会进构建接口的查询参数。里面只要出现换行,用户就能塞进任意
// Dockerfile 指令(比如 "redroid:latest\nRUN evil")。Rust 版有一个
// rejects_dockerfile_injection 测试盯着这件事,这里是同一条规则。
const IMAGE_REFERENCE = /^[A-Za-z0-9_./:@-]+$/

// 构建上下文里的文件名。不能有空格 —— Dockerfile 的 ADD 用空格分隔参数。
const CONTEXT_NAME = /^[A-Za-z0-9._-]+$/

const MAX_REFERENCE_LENGTH = 255
const MAX_LAYERS = 16

const checkReference = (value: string, field: string, label: string): void => {
  if (value === "") {
    throw new InvalidComposeSpec(field, `${label}不能为空`)
  }
  if (value.length > MAX_REFERENCE_LENGTH) {
    throw new InvalidComposeSpec(field, `${label}太长了`)
  }
  if (!IMAGE_REFERENCE.test(value)) {
    throw new InvalidComposeSpec(
      field,
      `${label}里有不允许的字符,只能是字母、数字和 _ . / : @ - :${value}`
    )
  }
}

const validateSpec = (spec: ComposeSpec): void => {
  checkReference(spec.base, "base", "基础镜像")
  checkReference(spec.target, "target", "输出标签")

  if (spec.base === spec.target) {
    throw new InvalidComposeSpec("target", "输出标签不能和基础镜像一样")
  }
  if (spec.layers.length === 0) {
    throw new InvalidComposeSpec("layers", "至少要有一个 tar 包")
  }
  if (spec.layers.length > MAX_LAYERS) {
    throw new InvalidComposeSpec("layers", `层太多了,最多 ${MAX_LAYERS} 个`)
  }
  spec.layers.forEach((layer, index) => {
    if (layer.content.byteLength === 0) {
      throw new InvalidComposeSpec(
        `layers[${index}]`,
        `${layer.name} 是个空文件`
      )
    }
  })
}

// 上传的文件名变成上下文里的文件名。
//
// 加 layer-序号- 前缀有两个作用:一是绝不会撞上我们自己写的 Dockerfile,
// 二是同名文件也不会互相覆盖(用户可能分几次传同一个名字)。
const contextNameFor = (original: string, index: number): string => {
  const withoutPath = original.split(/[\\/]/).pop() ?? ""
  const safe = withoutPath.replace(/[^A-Za-z0-9._-]/g, "_")
  return `layer-${index}-${safe !== "" ? safe : "layer.tar"}`
}

// Dockerfile 就这几行。tar 用 ADD 加进去 —— ADD 会自动解开 tar,所以层里的
// 文件会直接落到镜像根目录下。
const dockerfileFor = (
  spec: ComposeSpec,
  contextNames: ReadonlyArray<string>
): string => {
  const lines = [`FROM ${spec.base}`]
  for (const name of contextNames) lines.push(`ADD ${name} /`)
  lines.push(
    `LABEL ${MANAGED_LABEL}="true" io.github.redroid-helper.base-image="${spec.base}"`
  )
  return `${lines.join("\n")}\n`
}

// 把 Dockerfile 和各个层拼成一个 tar,就是构建上下文。
const buildContext = (
  spec: ComposeSpec,
  contextNames: ReadonlyArray<string>
): Promise<Buffer> => {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)))

  const entry = { mode: 0o644, uid: 0, gid: 0 }
  pack.entry({ ...entry, name: "Dockerfile" }, dockerfileFor(spec, contextNames))
  spec.layers.forEach((layer, index) => {
    pack.entry(
      { ...entry, name: contextNames[index] },
      Buffer.from(layer.content)
    )
  })
  pack.finalize()

  return new Promise((resolve, reject) => {
    pack.on("end", () => resolve(Buffer.concat(chunks)))
    pack.on("error", reject)
  })
}

// Docker 构建时吐出来的事件。只挑我们用得到的字段。
interface BuildEvent {
  readonly stream?: string
  readonly status?: string
  readonly error?: string
  readonly errorDetail?: { readonly message?: string }
  readonly aux?: { readonly ID?: string }
}

// @types/dockerode 里 buildImage 的第一个参数只允许"路径 / 流 / 目录上下文",
// 但运行时的 docker-modem 对 Buffer 也一样处理(实测能跑通,而且会据此算好
// Content-Length)。这里补一个我们确实会用的签名 —— 绕过的只是类型。
const buildImageFromBuffer = (
  docker: Docker,
  context: Buffer,
  options: Docker.ImageBuildOptions
): Promise<NodeJS.ReadableStream> => {
  const build = docker.buildImage.bind(docker) as unknown as (
    file: Buffer,
    options: Docker.ImageBuildOptions
  ) => Promise<NodeJS.ReadableStream>
  return build(context, options)
}

// 构建,并把输出边收边报出去。
//
// Docker 的构建响应是**一串 JSON,一行一个**(不是一次给你整个)。所以要
// 自己攒着按行切 —— 一个网络分片可能只包含半行。
const runBuild = async (
  docker: Docker,
  spec: ComposeSpec,
  context: Buffer,
  onProgress: (message: string) => void
): Promise<ComposeResult> => {
  const stream = await buildImageFromBuffer(docker, context, {
    t: spec.target,
    dockerfile: "Dockerfile",
    // 构建过程中产生的中间容器用完就删。forcerm 是"就算构建失败也删"。
    rm: true,
    forcerm: true,
    // 不自动拉取基础镜像:能选到就说明本地已经有,免得用户等一次意外的下载。
    pull: false,
  })

  let imageId: string | null = null
  let buffered = ""

  const handleLine = (line: string) => {
    const text = line.trim()
    if (text === "") return

    let event: BuildEvent
    try {
      event = JSON.parse(text) as BuildEvent
    } catch {
      // 解析不了就原样当一行日志,总比吞掉强
      onProgress(text)
      return
    }

    const failure = event.errorDetail?.message ?? event.error
    if (typeof failure === "string" && failure.trim() !== "") {
      throw new ComposeFailed(failure.trim())
    }
    if (event.aux?.ID !== undefined) imageId = event.aux.ID

    for (const raw of [event.stream, event.status]) {
      if (raw === undefined) continue
      for (const part of raw.split("\n")) {
        if (part.trim() !== "") onProgress(part.trimEnd())
      }
    }
  }

  for await (const chunk of stream) {
    buffered += String(chunk)
    let index = buffered.indexOf("\n")
    while (index >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      handleLine(line)
      index = buffered.indexOf("\n")
    }
  }
  handleLine(buffered)

  return { target: spec.target, imageId }
}

const inMegabytes = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MiB`
