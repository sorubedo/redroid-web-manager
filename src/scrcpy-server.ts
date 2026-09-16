import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * scrcpy 的服务端 jar。
 *
 * 它不在 redroid 镜像里(那是 Android 系统,不带这个),得我们自己准备一份:
 * 构建时下好、验过摘要、打进镜像,运行期读出来发给前端,前端再推到设备上
 * 跑起来 —— 后端不碰设备,也不懂 scrcpy 协议。
 *
 * 版本号要和前端那个库认的版本一致,对不上是"能跑起来但画面不对"这种很难查
 * 的问题。前端不再手抄一份,直接问库要(见 web/src/adb/scrcpy.ts)。
 */
export const SCRCPY_VERSION = "4.1"

const SCRCPY_SERVER_FILENAME = `scrcpy-server-v${SCRCPY_VERSION}`

const SCRCPY_SERVER_URL =
  "https://github.com/Genymobile/scrcpy/releases/download" +
  `/v${SCRCPY_VERSION}/${SCRCPY_SERVER_FILENAME}`

/** 官方发布物的摘要。下载时和发出去之前都验一次。 */
const SCRCPY_SERVER_SHA256 =
  "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae"

/** src 和 dist 是同一层,所以这里开发和部署时都指到 /app/assets。 */
const SCRCPY_SERVER_PATH = fileURLToPath(
  new URL(`../assets/${SCRCPY_SERVER_FILENAME}`, import.meta.url)
)

/** 拿不到 scrcpy 的 jar(下不下来、读不到、或者拿到的东西不对)。 */
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

/** 读镜像里那份 jar,发给前端。 */
export const readScrcpyServer = async (): Promise<ScrcpyServer> => {
  let jar: Buffer
  try {
    jar = await readFile(SCRCPY_SERVER_PATH)
  } catch (error) {
    throw new ScrcpyServerUnavailable(
      `读不到 scrcpy-server(${SCRCPY_SERVER_PATH})`,
      "这个 jar 是构建时下好打进镜像的,正常不会缺。本地开发先跑一次 pnpm fetch:scrcpy;自己构建的话看构建日志里那一步。",
      error
    )
  }

  const digest = createHash("sha256").update(jar).digest("hex")
  if (digest !== SCRCPY_SERVER_SHA256) {
    throw new ScrcpyServerUnavailable(
      `scrcpy-server 的摘要对不上(拿到 ${digest})`,
      "它被读坏了或者换过了,别用。重新构建镜像,或者本地重跑一次 pnpm fetch:scrcpy。"
    )
  }

  return { version: SCRCPY_VERSION, jar }
}

/** 下 jar、验摘要、放进 assets/。构建前跑一次,已经有对得上的一份就跳过。 */
export const fetchScrcpyServer = async (): Promise<{
  readonly path: string
  readonly downloaded: boolean
}> => {
  if (await hasUsableJar()) {
    return { path: SCRCPY_SERVER_PATH, downloaded: false }
  }

  const jar = await download()
  const digest = createHash("sha256").update(jar).digest("hex")
  if (digest !== SCRCPY_SERVER_SHA256) {
    throw new ScrcpyServerUnavailable(
      `scrcpy-server 的摘要对不上(拿到 ${digest},期望 ${SCRCPY_SERVER_SHA256})`,
      "可能是中间人换了或者代理返回了别的东西。过会儿再试;一直这样就查查版本号和摘要是不是该一起改。"
    )
  }

  // 先写 .part 再改名,中途被打断不会留下半个 jar 冒充能用的。
  await mkdir(path.dirname(SCRCPY_SERVER_PATH), { recursive: true })
  const temporary = `${SCRCPY_SERVER_PATH}.part`
  await writeFile(temporary, jar)
  await rename(temporary, SCRCPY_SERVER_PATH)

  return { path: SCRCPY_SERVER_PATH, downloaded: true }
}

const hasUsableJar = async (): Promise<boolean> => {
  try {
    const jar = await readFile(SCRCPY_SERVER_PATH)
    return createHash("sha256").update(jar).digest("hex") === SCRCPY_SERVER_SHA256
  } catch {
    return false
  }
}

const download = async (): Promise<Buffer> => {
  let response: Response
  try {
    response = await fetch(SCRCPY_SERVER_URL, { redirect: "follow" })
  } catch (error) {
    throw new ScrcpyServerUnavailable(
      `下载 scrcpy-server 失败:${error instanceof Error ? error.message : String(error)}`,
      `构建镜像的这台机器得能上 github.com。不方便出网就自己把 ${SCRCPY_SERVER_FILENAME} 放到 ${SCRCPY_SERVER_PATH},摘要对得上就不会再下了。`,
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
