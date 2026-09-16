import { parseArgs } from "node:util"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  ConfigError,
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  ENV_PREFIX,
  isLoopback,
  resolveServerConfig,
} from "./config.js"
import {
  DockerFailure,
  connectDocker,
  describeDockerEndpoint,
  parseDockerHost,
  probeDocker,
  resolveDockerHost,
} from "./docker-host.js"
import { createServer } from "./server.js"

/**
 * 启动流程:
 *
 *   1. 弄清楚自己听在哪儿(命令行 > 环境变量 > 默认值)和要连哪个 Docker
 *   2. 确认连得上、有权限 —— 连不上就直接退出,不要起一个用不了的服务
 *   3. 起 HTTP 服务,等前端来调
 */

const USAGE = `用法:redroid-web-manager [选项]

选项:
 --docker-host <地址>   要连接的 Docker 地址,可以写成
                         unix:///var/run/docker.sock(本机,默认)
                         tcp://127.0.0.1:2375(网络地址)
                         也可以用 ${ENV_PREFIX}DOCKER_HOST 或 DOCKER_HOST 指定
 --host <地址>          HTTP 服务监听的地址,默认 ${DEFAULT_BIND_HOST}(只有本机能连)。
                         写成 0.0.0.0 是"所有网卡" —— 在容器里跑的时候要这样,
                         但记得在宿主上把端口只发布到 127.0.0.1
 -p, --port <端口>      HTTP 服务监听的端口,默认 ${DEFAULT_PORT}
 --static-dir <目录>    一并托管前端页面(build 出来的 web/dist)。
                         不指定时自动找仓库里的 web/dist,找不到就只跑 API
 --no-web               不托管前端页面,只提供 /api
 -h, --help             显示这段帮助

环境变量(都带 ${ENV_PREFIX} 前缀,命令行优先):
  ${ENV_PREFIX}HOST           同 --host
  ${ENV_PREFIX}PORT           同 --port
  ${ENV_PREFIX}STATIC_DIR     同 --static-dir
  ${ENV_PREFIX}STATIC=off     同 --no-web
  ${ENV_PREFIX}DOCKER_HOST    同 --docker-host(优先级高于 DOCKER_HOST)
  ${ENV_PREFIX}ADB_HOST       去哪台机器连容器的 adb 端口。默认跟着容器的
                              绑定地址走(通常就是 127.0.0.1);后端自己跑在
                              容器里时要指到宿主,例如 host.docker.internal
`

/** 打印错误和提示,返回退出码 1。 */
const reportFailure = (error: unknown): number => {
  if (error instanceof DockerFailure || error instanceof ConfigError) {
    console.error(`错误:${error.message}`)
    if (error.hint !== "") console.error(`提示:${error.hint}`)
  } else {
    console.error(
      `错误:${error instanceof Error ? error.message : String(error)}`
    )
  }
  return 1
}

/**
 * 默认的前端目录。
 *
 * 跑 node dist/index.js 时这里是 <仓库>/dist,前端在 <仓库>/web/dist;
 * 跑 tsx src/index.ts 时这里是 <仓库>/src,得再往上一层。两个都试一遍,
 * 都不存在就返回常规位置,后面按"没找到"处理。
 */
const defaultStaticDir = (): string => {
  const here = import.meta.dirname
  const candidates = [
    path.resolve(here, "..", "web", "dist"),
    path.resolve(here, "..", "..", "web", "dist"),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/** 打印给人看的地址。0.0.0.0 不是能点开的地址,换成 127.0.0.1。 */
const displayUrl = (host: string, port: number): string => {
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  return `http://${shown.includes(":") ? `[${shown}]` : shown}:${port}`
}

const main = async (): Promise<number> => {
  let options
  try {
    options = parseArgs({
      args: process.argv.slice(2),
      options: {
        "docker-host": { type: "string" },
        host: { type: "string" },
        port: { type: "string", short: "p" },
        "static-dir": { type: "string" },
        "no-web": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    console.error(
      `错误:${error instanceof Error ? error.message : String(error)}`
    )
    console.error(USAGE)
    return 1
  }

  if (options.values.help === true) {
    console.log(USAGE)
    return 0
  }

  let config
  try {
    config = resolveServerConfig({
      fromCli: {
        host: options.values.host,
        port: options.values.port,
        staticDir: options.values["static-dir"],
        noWeb: options.values["no-web"] === true,
      },
      env: process.env,
      defaultStaticDir: defaultStaticDir(),
    })
  } catch (error) {
    return reportFailure(error)
  }

  // 目录存在才托管。默认目录不存在是正常的(还没 build,或者开发时前端归
  // vite);用户明确指了目录却没有 index.html,那就是指错了,要报错。
  let staticDir: string | null = null
  if (config.staticDir !== null) {
    if (existsSync(path.join(config.staticDir, "index.html"))) {
      staticDir = config.staticDir
    } else if (config.staticDirExplicit) {
      return reportFailure(
        new ConfigError(
          `这个目录里没有 index.html:${config.staticDir}`,
          "指到前端 build 出来的目录(默认是仓库里的 web/dist),或者加 --no-web 只跑 API"
        )
      )
    } else {
      console.log(
        `提示:没找到前端页面(${config.staticDir}),这次只提供 API。`
      )
      console.log("      pnpm build 之后就有了,开发时前端是 pnpm dev:web。")
    }
  }

  const rawHost = resolveDockerHost({
    fromCli: options.values["docker-host"],
    env: process.env,
  })

  let endpoint
  try {
    endpoint = parseDockerHost(rawHost)
  } catch (error) {
    return reportFailure(error)
  }

  console.log(`正在检查 Docker:${describeDockerEndpoint(endpoint)}`)
  const docker = connectDocker(endpoint)
  try {
    const info = await probeDocker(docker, endpoint)
    console.log(`✓ Docker 已就绪:${info.version}(API ${info.apiVersion})`)
  } catch (error) {
    return reportFailure(error)
  }

  const server = createServer({
    docker,
    endpoint,
    staticDir,
    adbHost: config.adbHost,
  })
  const { host, port } = config
  try {
    await server.listen({ host, port })
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined
    if (code === "EADDRINUSE") {
      console.error(`错误:端口 ${port} 已经被占用了`)
      console.error(
        `提示:换一个端口,例如 --port 3001,或者用 ${ENV_PREFIX}PORT=3001`
      )
      return 1
    }
    if (code === "EADDRNOTAVAIL") {
      console.error(`错误:这个地址不属于本机,绑不上:${host}`)
      console.error(
        `提示:ip addr 看看本机有哪些地址;只想让本机访问就用 ${DEFAULT_BIND_HOST},容器里想被转发就写 0.0.0.0`
      )
      return 1
    }
    if (code === "EACCES") {
      console.error(`错误:没有权限绑定 ${host}:${port}`)
      console.error("提示:1024 以下的端口要 root,换个端口吧。")
      return 1
    }
    return reportFailure(error)
  }

  const base = displayUrl(host, port)
  console.log(`✓ 后端已启动:${base}(监听 ${host}:${port})`)
  if (staticDir !== null) {
    console.log(`  前端页面也在这儿:${base}/`)
  } else {
    console.log("  这次只提供 /api,页面交给 vite / caddy / nginx 之类")
  }
  if (!isLoopback(host)) {
    // 这不是"警告你写错了" —— 在容器里跑就该这样。但得说清楚代价。
    console.log(
      `  ⚠ 监听的是 ${host}:同网段的机器都能连上,而这个服务能操作 Docker(等于 root)。`
    )
    console.log(
      `    容器里这么用没问题,但宿主上发布端口要写成 -p 127.0.0.1:${port}:${port}。`
    )
  }
  console.log(`  可以先试一下:${base}/api/health`)
  return 0
}

process.exitCode = await main()
