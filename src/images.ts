import type Docker from "dockerode"
import {
  statusCodeOf,
  translateDockerError,
  type DockerEndpoint,
} from "./docker-host.js"
import { MANAGED_LABEL } from "./labels.js"

/**
 * 这个模块回答两个不同的问题,但它们共用同一套判断规则:
 *
 *   listBaseImages   —— "哪些镜像能拿来叠 Magisk?"     只管原版的
 *   listUsableImages —— "哪些镜像能拿来起容器?"         原版的和派生出来的都算
 *
 * 规则只写一份(scanRedroidImages),两个函数只是在结果上按类别取子集。
 * 调用者拿到的是分好类的镜像,不用知道 Docker 的 JSON 长什么样,
 * 也不用知道"什么算派生镜像"。
 */

/** 官方 redroid 镜像的仓库名。 */
const REDROID_REPOSITORY = "redroid/redroid"

/**
 * 原版 = 能当基础继续叠 Magisk 的;
 * 派生 = 已经加工过的(程序造的,或者名字里就写着 magisk 的)。
 */
export type ImageKind = "official" | "derived"

export interface RedroidImage {
  /** 例:redroid/redroid:14.0.0_64only-latest */
  readonly reference: string
  /** 镜像 ID,形如 sha256:... */
  readonly id: string
  /** amd64 / arm64 —— 以后挑 Magisk 的 .so 要用它 */
  readonly architecture: string
  /** 字节数 */
  readonly size: number
  readonly kind: ImageKind
}

/**
 * 这个引用指不到本模块管的镜像。
 * 调用者不需要知道"什么算 redroid 镜像"——那是这个模块的事。
 */
export class ImageNotFound extends Error {
  readonly reference: string

  constructor(reference: string) {
    super(`本机没有这张 redroid 镜像:${reference}`)
    this.name = "ImageNotFound"
    this.reference = reference
  }
}

/** 镜像存在,但它不是 redroid 家族的,所以不归这里管。 */
export class NotARedroidImage extends Error {
  readonly reference: string

  constructor(reference: string) {
    super(`${reference} 不是 redroid 镜像`)
    this.name = "NotARedroidImage"
    this.reference = reference
  }
}

/**
 * 还有容器在用这张镜像,Docker 拒绝删除。
 *
 * 停着的容器也算"在用"——Docker 只是在磁盘上留着那层只读层。所以这不是
 * "镜像删不掉"这种技术故障,而是得先处理掉那些容器。
 */
export class ImageInUse extends Error {
  readonly reference: string

  constructor(reference: string) {
    super(`还有容器在用 ${reference},Docker 不让删`)
    this.name = "ImageInUse"
    this.reference = reference
  }
}

/** 能拿来当基础、继续叠 Magisk 的原版镜像。 */
export const listBaseImages = async (
  docker: Docker,
  endpoint: DockerEndpoint
): Promise<ReadonlyArray<RedroidImage>> =>
  (await scanRedroidImages(docker, endpoint)).filter(
    (image) => image.kind === "official"
  )

/** 能直接拿来起容器的镜像:原版的 + 程序造出来的派生镜像。 */
export const listUsableImages = (
  docker: Docker,
  endpoint: DockerEndpoint
): Promise<ReadonlyArray<RedroidImage>> => scanRedroidImages(docker, endpoint)

/**
 * 从本机删掉一张 redroid 镜像。
 *
 * 和删容器一样,这里只认 redroid 家族的镜像:引用是从 URL 里拼进来的,
 * 不挡住的话,一个写错(或者恶意)的请求就可能顺手删掉本机别的镜像。
 *
 * 还有容器在用这张镜像时 Docker 会回 409(跑着的和停着的都算),这里如实
 * 报出去,不拿 force 绕过去:强删只是把标签摘掉,容器还在,但引用就悬空了,
 * 下次想重建还得重新 pull。与其偷偷这么做,不如把话说明白。
 *
 * 另外,同一个镜像 ID 上可能挂着好几个标签 —— 删的是**引用**(标签),
 * 别的标签还在的话镜像本体不会消失。这也是界面上"一行一个引用"的含义。
 */
export const removeRedroidImage = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  reference: string
): Promise<void> => {
  await findRedroidImage(docker, endpoint, reference)
  try {
    await docker.getImage(reference).remove()
  } catch (error) {
    // 到这里才 404,说明 inspect 和删除之间镜像被别人删了 —— 结果一样,就是没了。
    if (statusCodeOf(error) === 404) throw new ImageNotFound(reference)
    if (statusCodeOf(error) === 409) throw new ImageInUse(reference)
    throw translateDockerError(endpoint, error)
  }
}

/* ---------- 内部实现:下面是两个函数共用的那套规则 ---------- */

type Labels = Readonly<Record<string, string>> | undefined

/** 这个镜像算不算 redroid 家族:官方命名空间,或者被程序管理过。 */
const isRedroidFamily = (labels: Labels, reference: string): boolean =>
  reference.startsWith(`${REDROID_REPOSITORY}:`) ||
  labels?.[MANAGED_LABEL] === "true"

const kindOf = (labels: Labels, reference: string): ImageKind =>
  labels?.[MANAGED_LABEL] === "true" || reference.includes("magisk")
    ? "derived"
    : "official"

/**
 * 镜像引用允许的字符。
 *
 * 这道检查是**防注入用的**:引用会被拼进 Docker 的请求路径,里面只要出现
 * `?` 就能塞进查询参数(比如 force=1),出现 `.` / `..` 段落就能把请求
 * 指到别的接口上去。容器那边的 id 检查是同一个道理。
 */
const SAFE_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

const MAX_REFERENCE_LENGTH = 255

const isSafeImageReference = (reference: string): boolean =>
  reference.length <= MAX_REFERENCE_LENGTH &&
  SAFE_IMAGE_REFERENCE.test(reference) &&
  reference.split("/").every((segment) => segment !== "." && segment !== "..")

/**
 * 找到镜像,并确认它归这个模块管。
 *
 * 这是模块的不变量:这个模块的世界里只有 redroid 镜像,别的镜像一律当
 * "不存在"。这样 HTTP 层就不可能因为写错或者是恶意请求,顺手把别的镜像
 * 删掉 —— 那通常是用户机器上别的东西,和这个程序无关。
 */
const findRedroidImage = async (
  docker: Docker,
  endpoint: DockerEndpoint,
  reference: string
) => {
  if (!isSafeImageReference(reference)) throw new ImageNotFound(reference)

  let inspect
  try {
    inspect = await docker.getImage(reference).inspect()
  } catch (error) {
    // 404 在这里的语义是"没这张镜像",不是"对面不是 Docker"——
    // 状态码的含义跟接口有关,所以要在这里先判断掉。
    if (statusCodeOf(error) === 404) throw new ImageNotFound(reference)
    throw translateDockerError(endpoint, error)
  }

  const labels = inspect.Config?.Labels as Labels
  if (!isRedroidFamily(labels, reference)) {
    throw new NotARedroidImage(reference)
  }

  return inspect
}

/** 把 Docker 里的镜像扫一遍,挑出 redroid 家族的,并分好类。 */
const scanRedroidImages = async (
  docker: Docker,
  endpoint: DockerEndpoint
): Promise<ReadonlyArray<RedroidImage>> => {
  const summaries = await request(endpoint, () =>
    docker.listImages({ all: false })
  )

  const images: RedroidImage[] = []
  for (const summary of summaries) {
    // Labels 在类型上是必填的,但 Docker 对没有标签的镜像会返回 null,
    // 所以这里还是要防一手。
    const labels = summary.Labels as Labels
    const references = (summary.RepoTags ?? []).filter((reference) =>
      isRedroidFamily(labels, reference)
    )
    if (references.length === 0) continue

    // 架构信息列表接口不给,得单独 inspect 一次
    const inspect = await request(endpoint, () =>
      docker.getImage(summary.Id).inspect()
    )
    const architecture = inspect.Architecture ?? "unknown"

    for (const reference of references) {
      images.push({
        reference,
        id: summary.Id,
        architecture,
        size: summary.Size,
        kind: kindOf(labels, reference),
      })
    }
  }

  return images.sort((a, b) => a.reference.localeCompare(b.reference))
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
