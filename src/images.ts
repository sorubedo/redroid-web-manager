import type Docker from "dockerode"
import { translateDockerError, type DockerEndpoint } from "./docker-host.js"
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
