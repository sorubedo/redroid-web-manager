import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify"
import multipart from "@fastify/multipart"
import fastifyStatic from "@fastify/static"
import websocket from "@fastify/websocket"
import type Docker from "dockerode"
import {
  AdbPortNotPublished,
  ContainerNotFound,
  ContainerNotRunning,
  NotARedroidContainer,
  listRedroidContainers,
  removeRedroidContainer,
  startRedroidContainer,
  stopRedroidContainer,
} from "./containers.js"
import { AdbConnectFailed } from "./adb/connection.js"
import { forwardAdbSocket, type AdbForwardSink } from "./adb/forward.js"
import { AdbSessions } from "./adb/sessions.js"
import {
  AdbPortTaken,
  ContainerNameTaken,
  ContainerStartFailed,
  InvalidContainerSpec,
  NoFreeAdbPort,
  createRedroidContainer,
} from "./create-container.js"
import {
  composeImage,
  type ComposeLayer,
} from "./compose-image.js"
import { DockerFailure, type DockerEndpoint } from "./docker-host.js"
import {
  ImageInUse,
  ImageNotFound,
  NotARedroidImage,
  listBaseImages,
  listUsableImages,
  removeRedroidImage,
} from "./images.js"
import { REDROID_PARAMETERS } from "./redroid-params.js"
import {
  NotAnOfficialImage,
  PullFailed,
  RegistryUnavailable,
  listOfficialImages,
  pullOfficialImage,
} from "./remote-images.js"
import {
  ScrcpyServerUnavailable,
  readScrcpyServer,
} from "./scrcpy-server.js"

// 上传的每个 tar 最大多少。这些内容会先整个读进内存再拼成构建上下文,
// 所以必须有上限 —— 不然一次大上传就能把后端进程撑爆。
const MAX_LAYER_BYTES = 512 * 1024 * 1024

// HTTP 接口层。它只做三件事:收请求、调用下面的模块、把结果或错误变回 JSON。
// 不碰 Docker,也不懂业务。

export interface ServerOptions {
  readonly docker: Docker
  readonly endpoint: DockerEndpoint
  /**
   * 前端静态目录(build 出来的 web/dist)。给了就在这里一起托管,没给
   * 就只提供 API —— 开发时前端归 vite 管,部署时可以用 --static-dir 指过来。
   */
  readonly staticDir?: string | null
  /**
   * 后端从哪儿去连容器的 adb 端口。null(默认)表示跟着容器的绑定地址走 ——
   * 后端和容器在同一台机器上时总是对的;后端自己跑在容器里时要显式指过去。
   */
  readonly adbHost?: string | null
}

// 把模块抛出来的错误翻译成 HTTP:一个状态码 + 一段给用户看的话。
// 这里也只做翻译,不做判断 —— 什么算是错误,由各个模块自己定义。
const describeFailure = (
  error: unknown
): { readonly status: number; readonly body: unknown } | null => {
  // 跟 Docker 说不上话 —— 这不是"服务器崩了",而是"后端还能跑,但它依赖的
  // Docker 现在不可用",所以用 503 而不是 500。
  if (error instanceof DockerFailure) {
    return {
      status: 503,
      body: {
        reason: error.reason,
        message: error.message,
        hint: error.hint,
      },
    }
  }
  if (error instanceof ContainerNotFound) {
    return { status: 404, body: { message: error.message, hint: "" } }
  }
  if (error instanceof NotARedroidContainer) {
    return {
      status: 409,
      body: { message: error.message, hint: "这里只管理 redroid 容器。" },
    }
  }
  // 容器不给连的两种情况:没发布端口、没在跑。都是"你得先去改点什么",
  // 所以是 409 而不是 404 —— 容器确实在。
  if (error instanceof AdbPortNotPublished) {
    return {
      status: 409,
      body: {
        message: error.message,
        hint: "端口映射在建容器的时候就定死了(Docker 不给已建的容器加端口),得重建一个,建的时候把 adb 端口填上。",
      },
    }
  }
  if (error instanceof ContainerNotRunning) {
    return {
      status: 409,
      body: {
        message: error.message,
        hint: "先在「容器」那一页把它启动起来。",
      },
    }
  }
  // 容器在跑、端口也发布着,但那条 TCP 就是连不上。多半是 Android 还没
  // 起来(redroid 开机要十几秒),所以算"依赖暂时不可用",和 Docker 连不上
  // 一样用 503,让调用方知道过会儿再来是有意义的。
  if (error instanceof AdbConnectFailed) {
    return {
      status: 503,
      body: {
        message: error.message,
        hint: "容器可能还在启动(Android 起来要十几秒),等会儿再试;一直这样就看容器的日志。",
      },
    }
  }
  // 镜像里那份 scrcpy 的 jar 读不到或者摘要不对。这条路径正常永远不该走到
  // —— jar 是构建时下好、验过、和镜像一起发出去的,走到这儿说明这次构建
  // 有问题(或者有人动了容器里的文件)。是程序自己的毛病,所以是 500,
  // 不是"依赖暂时不可用"那种 503。
  if (error instanceof ScrcpyServerUnavailable) {
    return {
      status: 500,
      body: { message: error.message, hint: error.hint },
    }
  }
  if (error instanceof ImageNotFound) {
    return { status: 404, body: { message: error.message, hint: "" } }
  }
  if (error instanceof NotARedroidImage) {
    return {
      status: 409,
      body: { message: error.message, hint: "这里只管理 redroid 镜像。" },
    }
  }
  // 镜像删不掉,是因为还挂着容器(跑着的、停着的都算)。Docker 自己会拦,
  // 这里只负责告诉用户接下来该干什么。
  if (error instanceof ImageInUse) {
    return {
      status: 409,
      body: {
        message: error.message,
        hint: "先用「容器」那一页把用它的容器删掉,再回来删镜像。",
      },
    }
  }
  // 问不到 Docker Hub:后端能跑,只是这台机器上不了外网(或者被限流了)。
  // 和 DockerFailure 一样是"依赖不可用",所以也是 503。
  if (error instanceof RegistryUnavailable) {
    return {
      status: 503,
      body: { message: error.message, hint: error.hint },
    }
  }
  if (error instanceof NotAnOfficialImage) {
    return {
      status: 400,
      body: {
        message: error.message,
        hint: "拉取只对官方仓库开放,列表里挑一张就行。",
      },
    }
  }
  // 拉取中途 Docker 失败了。响应头早就发出去了(那是个流),这里的错误
  // 会作为最后一行 error 事件给前端。
  if (error instanceof PullFailed) {
    return {
      status: 500,
      body: { message: error.message, hint: error.hint },
    }
  }
  if (error instanceof InvalidContainerSpec) {
    return {
      status: 400,
      body: { field: error.field, message: error.message, hint: "" },
    }
  }
  if (
    error instanceof ContainerNameTaken ||
    error instanceof NoFreeAdbPort ||
    error instanceof AdbPortTaken
  ) {
    return { status: 409, body: { message: error.message, hint: "" } }
  }
  // 容器建出来了但没跑起来。这时候状态是"做了一半",不是 4xx 也不是纯粹的
  // 服务不可用,但它确实是个需要人看一眼的失败,所以按 500 报,消息里说清楚
  // 容器还在。
  if (error instanceof ContainerStartFailed) {
    return { status: 500, body: { message: error.message, hint: "" } }
  }
  return null
}

/**
 * WebSocket 收到的东西 -> 字节。
 *
 * ws 给过来的可能是 Buffer、ArrayBuffer、分片时的数组,也可能(别人手写
 * 的请求)是文本。我们只走二进制:文本没有意义,当没收到。
 */
const toBytes = (data: unknown): Uint8Array | null => {
  if (typeof data === "string") return null
  if (data instanceof ArrayBuffer) return new Uint8Array(data)

  if (Array.isArray(data)) {
    // 分片的二进制消息。ADB 本来就是字节流,拼起来正好 —— 分片边界没有
    // 任何含义。
    const chunks: Uint8Array[] = []
    for (const part of data) {
      const chunk = toBytes(part)
      if (chunk !== null) chunks.push(chunk)
    }
    const joined = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    )
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return joined
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  return null
}

/** 按字节截断,别把一个多字节的字符切成两半。 */
const sliceBytes = (text: string, maxBytes: number): string => {
  let result = ""
  for (const char of text) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes) break
    result += char
  }
  return result
}

/**
 * 关 WebSocket 时给对面带一句话。
 *
 * ws 对 close 帧的说明文字有 123 字节的硬限制,超了整帧会被丢掉 —— 浏览器
 * 那边就只剩一个没头没尾的 1006,什么都看不出来。所以必须按字节截断。
 */
const closeReason = (error: unknown): string => {
  const described = describeFailure(error)
  const body = (described?.body ?? {
    message: error instanceof Error ? error.message : String(error),
    hint: "",
  }) as { readonly message?: string; readonly hint?: string }

  const message = body.message ?? "未知错误"
  const text = body.hint ? `${message} —— ${body.hint}` : message
  return sliceBytes(text, 120)
}

export const createServer = (options: ServerOptions): FastifyInstance => {
  const { docker, endpoint, staticDir, adbHost = null } = options
  const app = Fastify({ logger: false })

  app.register(multipart, {
    limits: { fileSize: MAX_LAYER_BYTES, files: 16, fields: 10 },
  })

  // WebSocket 的插件注册必须在"带 websocket: true 的路由"之前被加载:
  // 它是靠 onRoute 钩子认出这些路由的,而这个钩子要等插件加载时才挂上去。
  // 下面那条 WS 路由因此放在一个子插件里(见「ADB 转发」那一段)。
  app.register(websocket)

  // 每个容器一条到 adbd 的长连接,所有会话共用。它是有状态的(连接、借用
  // 计数、空闲计时器),所以建一次放在这儿,跟着这个 server 实例走。
  const adbSessions = new AdbSessions({ docker, endpoint, host: adbHost })
  app.addHook("onClose", () => {
    adbSessions.close()
  })

  // 每个请求打一行,方便你对着浏览器确认请求真的到了后端
  app.addHook("onResponse", (request, reply) => {
    console.log(`${request.method} ${request.url} -> ${reply.statusCode}`)
  })

  // 所有接口的骨架都一样:调模块,成功把数据返回,失败翻译成状态码。
  // 抽出来之后,每个路由就只剩一行。
  const handler =
    <A>(run: (request: FastifyRequest) => Promise<A>) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await run(request)
      } catch (error) {
        const described = describeFailure(error)
        if (described === null) throw error
        reply.status(described.status)
        return described.body
      }
    }

  // 路径参数里的容器 id。类型上 Fastify 只知道它是 string,所以这里收口一次。
  const containerId = (request: FastifyRequest): string =>
    (request.params as { id: string }).id

  // 路径参数里的镜像引用。引用里有 `/` 和 `:`,前端那边是 encodeURIComponent
  // 过的,Fastify 会再解回来,所以这里拿到的就是原样的引用。
  const imageReference = (request: FastifyRequest): string =>
    (request.params as { reference: string }).reference

  // 「边跑边说」的接口骨架:先把响应头定下来,然后一行行往外写 JSON,最后
  // 一定收尾。拉镜像和合成镜像是同一个形状 —— 它们都是"跑几分钟、过程中
  // 有进度、最后给个结果",所以响应头、错误翻译、收尾只写这一份。
  //
  // 这里不能用上面那个 handler 包装:那套是"要么一个结果,要么一个错误"。
  const streamNdjson = async (
    reply: FastifyReply,
    run: (send: (payload: unknown) => void) => Promise<void>
  ): Promise<void> => {
    reply.hijack()
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    })

    // 用户中途关掉页面、连接断了之后,再往里写会变成 socket 错误。那不是
    // "服务出错",只是没人听了 —— 当它没发生,send 直接空转。
    reply.raw.on("error", () => {})
    const send = (payload: unknown) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return
      reply.raw.write(`${JSON.stringify(payload)}\n`)
    }

    try {
      await run(send)
    } catch (error) {
      const described = describeFailure(error)
      const body = (described?.body ?? {
        message: error instanceof Error ? error.message : String(error),
        hint: "",
      }) as { readonly message?: string; readonly hint?: string }
      send({
        type: "error",
        message: body.message ?? "未知错误",
        hint: body.hint ?? "",
      })
    } finally {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end()
    }
  }

  app.get("/api/health", () => ({ ok: true }))

  // 原版镜像 —— 用来选一张基础镜像去叠 Magisk。
  app.get(
    "/api/images/base",
    handler(async () => ({ images: await listBaseImages(docker, endpoint) }))
  )

  // 可用镜像 —— 能直接拿来起容器的,包括程序造出来的派生镜像。
  app.get(
    "/api/images/usable",
    handler(async () => ({ images: await listUsableImages(docker, endpoint) }))
  )

  // Docker Hub 上的官方镜像列表。这一步要出网,拿不到就是 503,
  // 和"本机 Docker 读不到"分开报 —— 两件事的对策不一样。
  app.get(
    "/api/images/official",
    handler(async () => ({ images: await listOfficialImages(docker, endpoint) }))
  )

  // 删掉一张镜像(按标签)。还挂着容器的话 Docker 会拦,那是 409 ——
  // 这里不 force,理由见 images.ts。
  app.delete(
    "/api/images/:reference",
    handler(async (request) => {
      await removeRedroidImage(docker, endpoint, imageReference(request))
      return { ok: true }
    })
  )

  app.get(
    "/api/containers",
    handler(async () => ({
      containers: await listRedroidContainers(docker, endpoint),
    }))
  )

  // 建一台新容器。请求体里的东西全是网络上来的,所以校验放在模块里做
  // (见 create-container.ts 的 parseSpec),这里原样递过去。
  app.post(
    "/api/containers",
    handler(async (request) =>
      createRedroidContainer(docker, endpoint, request.body)
    )
  )

  // redroid 官方文档里的参数表。创建容器的表单是照着它生成的,
  // 所以不能由前端自己写一份 —— 两边会跑偏。
  app.get("/api/redroid-params", () => ({ parameters: REDROID_PARAMETERS }))

  // 镜像合成台:收下基础镜像、输出标签和若干个 tar,交给 Docker 构建。
  // 边构建边把日志推给前端,所以走 streamNdjson。
  app.post("/api/compose", (request, reply) =>
    streamNdjson(reply, async (send) => {
      const log = (message: string) => send({ type: "log", message })
      const layers: ComposeLayer[] = []
      let base = ""
      let target = ""

      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "base") base = String(part.value)
          if (part.fieldname === "target") target = String(part.value)
        } else {
          const content = await part.toBuffer()
          layers.push({ name: part.filename, content })
          log(
            `收到 ${part.filename}(${(content.byteLength / 1024 / 1024).toFixed(1)} MiB)`
          )
        }
      }

      const result = await composeImage(
        docker,
        endpoint,
        { base, target, layers },
        log
      )
      send({ type: "done", target: result.target, imageId: result.imageId })
    })
  )

  // 拉一张官方镜像。拉几个 G 要好几分钟,所以进度得边拉边推 —— 同样是
  // streamNdjson,一行 layer 就是一层 blob 的进度。
  app.post("/api/images/pull", (request, reply) =>
    streamNdjson(reply, async (send) => {
      const reference = (request.body as { reference?: unknown } | null)
        ?.reference
      const pulled = await pullOfficialImage(
        docker,
        endpoint,
        reference,
        send
      )
      send({ type: "done", reference: pulled })
    })
  )

  app.post(
    "/api/containers/:id/start",
    handler(async (request) => {
      await startRedroidContainer(docker, endpoint, containerId(request))
      return { ok: true }
    })
  )

  app.post(
    "/api/containers/:id/stop",
    handler(async (request) => {
      const id = containerId(request)
      await stopRedroidContainer(docker, endpoint, id)
      // 停掉的容器那条 adb 连接已经没用了。虽然它自己也会断,但这里立刻
      // 忘掉,免得下一次请求先撞上一条死连接再重连。
      adbSessions.forget(id)
      return { ok: true }
    })
  )

  app.delete(
    "/api/containers/:id",
    handler(async (request) => {
      const id = containerId(request)
      await removeRedroidContainer(docker, endpoint, id)
      adbSessions.forget(id)
      return { ok: true }
    })
  )

  /* ---------- ADB 转发 ---------- */

  // 浏览器要拿这些才能造出一个 Adb 实例:banner(屏幕上看不到的型号信息)、
  // 单包最大长度、以及有哪边支持哪些 feature(决定它用 shell v1 还是 v2)。
  // 这些都是握手时 adbd 告诉我们的,浏览器自己连不到 adbd,只能来问。
  app.get(
    "/api/containers/:id/adb",
    handler(async (request) => {
      const lease = await adbSessions.acquire(containerId(request))
      try {
        const { adb } = lease
        return {
          serial: adb.serial,
          maxPayloadSize: adb.maxPayloadSize,
          clientFeatures: adb.clientFeatures,
          banner: {
            product: adb.banner.product,
            model: adb.banner.model,
            device: adb.banner.device,
            features: adb.banner.features,
          },
        }
      } finally {
        lease.release()
      }
    })
  )

  // 一条 WebSocket 对应设备上的一条 ADB socket。?service= 就是 ADB 的
  // service 字符串(adb shell 是 `shell:...`,推文件是 `sync:`,scrcpy 是
  // `localabstract:scrcpy`),原样交给设备,不解释也不过滤 —— 这是方案 A
  // 有意选的:能连上就等于容器里的超级管理员。
  //
  // 放在子插件里是因为要等 websocket 插件的 onRoute 钩子挂上(见上面)。
  app.register(async (scope) => {
    scope.get(
      "/api/containers/:id/adb/ws",
      { websocket: true },
      (socket, request) => {
        const id = (request.params as { id: string }).id
        const service = (request.query as { service?: string }).service
        if (service === undefined || service === "") {
          socket.close(1008, "缺少 service 参数")
          return
        }

        // 这个回调不能是 async 的:Fastify 会把返回的 Promise 当成"请求还没
        // 处理完",而 WebSocket 的生命周期跟路由时长没关系。所以自己起一个
        // 立即执行的函数,错误在里面收口 —— 那时候 HTTP 响应早就发出去了,
        // 唯一的报错途径就是关掉这条 WS 并带上原因。
        void (async () => {
          // WebSocket 的形状正好就是 AdbForwardSink 要的那几样,所以这里
          // 只做一次转换,不 import ws 的类型 —— 转发器那边对这个对象没有
          // 更多要求。
          const sink: AdbForwardSink = {
            get bufferedAmount() {
              return socket.bufferedAmount
            },
            send: (chunk) => {
              socket.send(chunk)
            },
            close: () => {
              // ws 的 close 不带参数是"正常关闭";对面自己已经关了的时候
              // 再调一次也没事(它会自己忽略)。
              socket.close()
            },
            onMessage: (listener) => {
              socket.on("message", (data: unknown) => {
                const chunk = toBytes(data)
                if (chunk !== null) listener(chunk)
              })
            },
            onClose: (listener) => {
              socket.on("close", () => listener())
            },
          }

          let lease
          try {
            lease = await adbSessions.acquire(id)
          } catch (error) {
            socket.close(1011, closeReason(error))
            return
          }

          try {
            await forwardAdbSocket(sink, lease.adb, service)
          } catch (error) {
            socket.close(1011, closeReason(error))
          } finally {
            lease.release()
          }
        })()
      }
    )
  })

  // scrcpy 的服务端(一个七百多 KB 的 jar)。前端要把它推到设备上,所以这里
  // 原样发给前端 —— 后端不碰设备,也不碰 scrcpy 协议。
  // 这份 jar 是构建时下好、打进镜像的,这里只负责读出来发过去:不出网,
  // 也不写盘。
  app.get("/api/scrcpy/server", async (request, reply) => {
    try {
      const { version, jar } = await readScrcpyServer()
      reply.header("X-Scrcpy-Version", version)
      // 前端每次会话都可能来取,而内容按版本号是不变的,让它自己缓存。
      reply.header("Cache-Control", "no-cache")
      return await reply.type("application/java-archive").send(jar)
    } catch (error) {
      const described = describeFailure(error)
      if (described === null) throw error
      reply.status(described.status)
      return described.body
    }
  })

  // 前端页面。放在所有 API 路由后面注册,免得静态路由先把手伸到 /api 上。
  //
  // 单进程单端口的好处是不用再配一个静态服务器,也不用处理跨域:页面和
  // /api 同源。想分开部署(比如前端交给 CDN 或 caddy)就不传 staticDir。
  if (staticDir !== null && staticDir !== undefined) {
    app.register(fastifyStatic, { root: staticDir, index: ["index.html"] })

    // 前端是单页应用:没匹配到文件的路径都回首页,让前端自己路由。
    // /api 底下不这么干 —— 拼错的接口该是 404,不该悄悄返回一份 HTML。
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api")) {
        reply.status(404)
        return { message: `没有这个接口:${request.method} ${request.url}`, hint: "" }
      }
      return reply.sendFile("index.html")
    })
  }

  return app
}
