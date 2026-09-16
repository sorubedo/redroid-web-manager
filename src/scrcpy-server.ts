import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * scrcpy 的"服务端"是一个 jar,得推到容器里用 app_process 跑起来。
 *
 * 它不在 redroid 镜像里(那是 Android 系统,不带这个),所以得我们自己准备
 * 一份。官方发布在 GitHub 上,这里下下来缓存住,再原样发给前端 —— 前端把它
 * 推给设备。**后端不碰设备,也不懂 scrcpy 协议**,只当一个缓存的搬运工
 * (方案 A 的分工)。
 *
 * 版本号必须和前端构造参数时用的那个严格一致:scrcpy 每个版本的命令行参数
 * 表都在变,版本对不上时是"能跑起来但画面不对"这种很难查的问题。前端那份
 * 在 web/src/adb/scrcpy.ts,两边一起改。
 */
export const SCRCPY_VERSION = "4.1"

const DOWNLOAD_URL =
  "https://github.com/Genymobile/scrcpy/releases/download" +
  `/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`

/**
 * 下载下来的东西必须和这个摘要对得上。
 *
 * 这个 jar 会被推到设备上、以 root 身份跑起来,所以"下到一半"和"被人换了
 * 一个"都得挡住。摘要不对就直接报错,别缓存,也别发给前端。
 */
const SHA256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae"

const CACHE_DIR = path.join(tmpdir(), "redroid-web-manager")
const CACHE_PATH = path.join(CACHE_DIR, `scrcpy-server-v${SCRCPY_VERSION}`)

/** 拿不到 scrcpy 的 jar(下不下来、或者下到的东西不对)。 */
export class ScrcpyServerUnavailable extends Error {
  readonly hint: string

  constructor(message: string, hint: string, cause?: unknown) {
    super(message, { cause })
    this.name = "ScrcpyServerUnavailable"
    this.hint = hint
  }
}

export interface ScrcpyServer {
  readonly version: string
  readonly jar: Buffer
}

/**
 * 拿到 scrcpy 的 jar:本地有就用本地的,没有就下一份存下来。
 *
 * 存的地方是系统临时目录 —— 这个文件七百多 KB,丢了再下一次的代价可以忽略,
 * 不值得为它引入"数据目录该放哪儿"这种配置。
 */
export const readScrcpyServer = async (): Promise<ScrcpyServer> => {
  const cached = await readCache()
  if (cached !== null) return { version: SCRCPY_VERSION, jar: cached }

  const jar = await download()
  const digest = createHash("sha256").update(jar).digest("hex")
  if (digest !== SHA256) {
    throw new ScrcpyServerUnavailable(
      `scrcpy-server 的摘要对不上(拿到 ${digest})`,
      "可能是下载被中间人换了或者网络代理返回了别的东西。把缓存删掉再试一次。"
    )
  }

  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(CACHE_PATH, jar)
  } catch {
    // 缓存写不进去(只读文件系统之类)不算失败 —— 这次照样能发给前端,
    // 大不了下次重新下。
  }

  return { version: SCRCPY_VERSION, jar }
}

const readCache = async (): Promise<Buffer | null> => {
  try {
    const jar = await readFile(CACHE_PATH)
    const digest = createHash("sha256").update(jar).digest("hex")
    // 缓存可能是上次没写完就断电留下的。摘要不对就当没有。
    return digest === SHA256 ? jar : null
  } catch {
    return null
  }
}

const download = async (): Promise<Buffer> => {
  let response: Response
  try {
    response = await fetch(DOWNLOAD_URL, { redirect: "follow" })
  } catch (error) {
    throw new ScrcpyServerUnavailable(
      `下载 scrcpy-server 失败:${error instanceof Error ? error.message : String(error)}`,
      `这台机器得能上 github.com。上不了网的话,手动把 jar 放到缓存目录(${CACHE_PATH})。`,
      error
    )
  }

  if (!response.ok) {
    throw new ScrcpyServerUnavailable(
      `下载 scrcpy-server 失败:HTTP ${response.status}`,
      "多半是代理或者 GitHub 那边的问题,过会儿再试。"
    )
  }

  return Buffer.from(await response.arrayBuffer())
}
