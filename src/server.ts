import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify"
import multipart from "@fastify/multipart"
import fastifyStatic from "@fastify/static"
import type Docker from "dockerode"
import {
  ContainerNotFound,
  NotARedroidContainer,
  listRedroidContainers,
  removeRedroidContainer,
  startRedroidContainer,
  stopRedroidContainer,
} from "./containers.js"
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
import { listBaseImages, listUsableImages } from "./images.js"
import { REDROID_PARAMETERS } from "./redroid-params.js"

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

export const createServer = (options: ServerOptions): FastifyInstance => {
  const { docker, endpoint, staticDir } = options
  const app = Fastify({ logger: false })

  app.register(multipart, {
    limits: { fileSize: MAX_LAYER_BYTES, files: 16, fields: 10 },
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
  //
  // 这个接口是**流式**的:响应一开头就定下来,然后一行行往外写 JSON,前端
  // 边收边显示构建日志。正因为要边跑边说,它不能用上面那个 handler 包装
  // (那套是"要么一个结果,要么一个错误")。
  app.post("/api/compose", async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    })

    const send = (payload: unknown) => {
      reply.raw.write(`${JSON.stringify(payload)}\n`)
    }
    const log = (message: string) => send({ type: "log", message })

    try {
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
    } catch (error) {
      const described = describeFailure(error)
      const body = (described?.body ?? {
        message: error instanceof Error ? error.message : String(error),
        hint: "",
      }) as { message?: string; hint?: string }
      send({
        type: "error",
        message: body.message ?? "未知错误",
        hint: body.hint ?? "",
      })
    } finally {
      reply.raw.end()
    }
  })

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
      await stopRedroidContainer(docker, endpoint, containerId(request))
      return { ok: true }
    })
  )

  app.delete(
    "/api/containers/:id",
    handler(async (request) => {
      await removeRedroidContainer(docker, endpoint, containerId(request))
      return { ok: true }
    })
  )

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
