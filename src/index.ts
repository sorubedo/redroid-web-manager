import { parseArgs } from "node:util"
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
 *   1. 弄清楚要连哪个 Docker(命令行 > 环境变量 > 默认值)
 *   2. 确认连得上、有权限 —— 连不上就直接退出,不要起一个用不了的服务
 *   3. 起 HTTP 服务,等前端来调
 */

const DEFAULT_PORT = 3000

const USAGE = `用法:redroid-web-manager [选项]

选项:
  --docker-host <地址>   要连接的 Docker 地址,可以写成
                         unix:///var/run/docker.sock(本机,默认)
                         tcp://127.0.0.1:2375(网络地址)
                         也可以用环境变量 DOCKER_HOST 指定
  -p, --port <端口>      HTTP 服务监听的端口,默认 ${DEFAULT_PORT}
  -h, --help             显示这段帮助
`

/** 打印错误和提示,返回退出码 1。 */
const reportFailure = (error: unknown): number => {
  if (error instanceof DockerFailure) {
    console.error(`错误:${error.message}`)
    if (error.hint !== "") console.error(`提示:${error.hint}`)
  } else {
    console.error(
      `错误:${error instanceof Error ? error.message : String(error)}`
    )
  }
  return 1
}

const main = async (): Promise<number> => {
  let options
  try {
    options = parseArgs({
      args: process.argv.slice(2),
      options: {
        "docker-host": { type: "string" },
        port: { type: "string", short: "p" },
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

  const port = options.values.port === undefined ? DEFAULT_PORT : Number(options.values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      `错误:--port 要是 1 到 65535 之间的整数,收到的是:${options.values.port}`
    )
    return 1
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

  const server = createServer({ docker, endpoint })
  try {
    // 只监听本机:这个服务没有任何登录验证,而它能操作 Docker
    // (等于 root 权限),不该暴露到网络上。
    await server.listen({ host: "127.0.0.1", port })
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined
    if (code === "EADDRINUSE") {
      console.error(`错误:端口 ${port} 已经被占用了`)
      console.error(`提示:换一个端口,例如 pnpm dev:server --port 3001`)
      return 1
    }
    return reportFailure(error)
  }

  console.log(`✓ 后端已启动:http://127.0.0.1:${port}`)
  console.log(`  可以先试一下:http://127.0.0.1:${port}/api/images`)
  return 0
}

process.exitCode = await main()
