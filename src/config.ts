import { isIP } from "node:net"

/**
 * 启动参数和环境变量。
 *
 * 环境变量一律带 REDROID_WEB_ 前缀:HOST、PORT、STATIC 这些名字太常见了,
 * 裸着用迟早和别人的东西撞上。唯一的例外是 DOCKER_HOST —— 那是 Docker 自己
 * 的约定,现在也还能用(带前缀的那个优先)。
 *
 * 优先级统一是:命令行 > 环境变量 > 默认值。
 */

export const ENV_PREFIX = "REDROID_WEB_"

export const DEFAULT_PORT = 3000

/**
 * 默认只听本机。
 *
 * 这个服务没有任何登录验证,却能操作 Docker —— 那等于把宿主机交给对方。
 * 只有在容器里跑、外面又只发布到宿主 loopback 的时候,才该改成 0.0.0.0。
 */
export const DEFAULT_BIND_HOST = "127.0.0.1"

/** 环境变量的全名,打印提示时用得上。 */
export const envName = (suffix: string): string => `${ENV_PREFIX}${suffix}`

/** 启动参数/环境变量写错了。带上"该怎么办",和 DockerFailure 一个路子。 */
export class ConfigError extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = "ConfigError"
    this.hint = hint
  }
}

export interface ServerConfig {
  readonly host: string
  readonly port: number
  /** 前端静态目录;null 表示这次只提供 API */
  readonly staticDir: string | null
  /** 目录是用户明确指定的还是默认推出来的 —— 指定的找不到要报错,默认的找不到就算了 */
  readonly staticDirExplicit: boolean
}

const nonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? null : trimmed
}

/** 命令行 > 环境变量,两边都没写就是 null。 */
const pick = (
  fromCli: string | undefined,
  suffix: string,
  env: Record<string, string | undefined>
): string | null => nonEmpty(fromCli) ?? nonEmpty(env[envName(suffix)])

const resolvePort = (
  fromCli: string | undefined,
  env: Record<string, string | undefined>
): number => {
  const raw = pick(fromCli, "PORT", env)
  if (raw === null) return DEFAULT_PORT

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `端口要是 1 到 65535 之间的整数,收到的是:${raw}`,
      `用 --port 3000 或者 ${envName("PORT")}=3000 指定`
    )
  }
  return port
}

const resolveHost = (
  fromCli: string | undefined,
  env: Record<string, string | undefined>
): string => {
  const raw = pick(fromCli, "HOST", env)
  if (raw === null) return DEFAULT_BIND_HOST

  // 这里只收 IP 字面量(localhost 也放行)。写个主机名进来,绑定成什么
  // 取决于 DNS,那不是"我想让这服务听在哪"该有的不确定性。
  if (isIP(raw) === 0 && raw !== "localhost") {
    throw new ConfigError(
      `监听地址要写成 IP,收到的是:${raw}`,
      `例如 ${DEFAULT_BIND_HOST}(只有本机能连,默认)、0.0.0.0(所有网卡,容器里用)、::1(IPv6 本机)`
    )
  }
  return raw
}

const isOff = (value: string): boolean =>
  ["off", "0", "false", "no"].includes(value.toLowerCase())

/**
 * 前端静态目录。
 *
 * 默认是仓库里的 web/dist(build 的产物);找不到就当没有,不影响 API。
 * 明确指定了目录却找不到 index.html,那是写错了,要报错而不是默默跳过。
 */
const resolveStaticDir = (options: {
  readonly fromCli: string | undefined
  readonly noWeb: boolean
  readonly env: Record<string, string | undefined>
  readonly fallback: string
}): { readonly dir: string | null; readonly explicit: boolean } => {
  if (options.noWeb) return { dir: null, explicit: true }

  const fromCliDir = nonEmpty(options.fromCli)
  const fromEnvDir = nonEmpty(options.env[envName("STATIC_DIR")])
  const chosen = fromCliDir ?? fromEnvDir
  if (chosen !== null) return { dir: chosen, explicit: true }

  // 只想关掉、不想换目录的话,用这个开关。
  const fromEnvFlag = nonEmpty(options.env[envName("STATIC")])
  if (fromEnvFlag !== null && isOff(fromEnvFlag)) {
    return { dir: null, explicit: true }
  }

  return { dir: options.fallback, explicit: false }
}

export const resolveServerConfig = (options: {
  readonly fromCli: {
    readonly host: string | undefined
    readonly port: string | undefined
    readonly staticDir: string | undefined
    readonly noWeb: boolean
  }
  readonly env: Record<string, string | undefined>
  /** 默认的前端目录,由调用者按自己的位置算出来 */
  readonly defaultStaticDir: string
}): ServerConfig => {
  const staticDir = resolveStaticDir({
    fromCli: options.fromCli.staticDir,
    noWeb: options.fromCli.noWeb,
    env: options.env,
    fallback: options.defaultStaticDir,
  })

  return {
    host: resolveHost(options.fromCli.host, options.env),
    port: resolvePort(options.fromCli.port, options.env),
    staticDir: staticDir.dir,
    staticDirExplicit: staticDir.explicit,
  }
}

/** 是不是"只有本机能连"的地址。不是的话启动时要提醒一句。 */
export const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "::1" || host.startsWith("127.")
