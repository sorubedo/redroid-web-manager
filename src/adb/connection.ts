import { connect, type Socket } from "node:net"
import type {
  AdbDaemonConnection,
  AdbPacketData,
  AdbPacketInit,
} from "@yume-chan/adb"
import { AdbPacket, AdbPacketHeader } from "@yume-chan/adb"
import type { Consumable } from "@yume-chan/stream-extra"
import {
  DuplexStreamFactory,
  PushReadableStream,
  StructDeserializeStream,
  WritableStream,
} from "@yume-chan/stream-extra"

/**
 * 把一条普通 TCP 连接变成 Tango 能用的 adb daemon 连接。
 *
 * ADB 有两套协议,别搞混:
 *   1. client 跟 server(也就是 5037 那个 adb server,命令都长成 host:xxx)
 *   2. client 跟设备上的 adbd(这里要的就是这套,握手、认证、多路复用都在里面)
 *
 * Tango 把两套都实现了,但只带了两种接法:USB(WebUSB),和去连 Google 的
 * adb server。**直连 TCP 的接法它没打包** —— redroid 容器的 adbd 偏偏就是
 * TCP 暴露的,所以这一段得自己写。
 *
 * 这个模块的职责只有一条:TCP 的字节流进 -> ADB 的包进出。握手、认证、
 * 一个连接上跑多少个 socket,全是 Tango 的事,这里不掺和。
 */

export interface AdbTcpTarget {
  readonly host: string
  readonly port: number
}

/**
 * 拿不到一条能用的 adb 连接。
 *
 * 两种卡法:TCP 就没连上(容器没在跑,或者它的 5555 没有发布到宿主上),
 * 或者连上了但握手没成(adbd 还没起来、半路被掐)。消息里带上地址和卡在
 * 哪一步,因为"哪个容器"这件事调用者已经知道了 —— 报错只要说清楚"去哪儿
 * 找它、找得怎么样"。
 */
export class AdbConnectFailed extends Error {
  readonly target: AdbTcpTarget

  constructor(
    target: AdbTcpTarget,
    cause: unknown,
    stage: "connect" | "handshake" = "connect"
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      stage === "connect"
        ? `连不上 ${target.host}:${target.port} 上的 adb:${detail}`
        : `连上了 ${target.host}:${target.port},但 ADB 握手没成功:${detail}`,
      { cause }
    )
    this.name = "AdbConnectFailed"
    this.target = target
  }
}

/**
 * 一条已经连上的 adb daemon 连接。
 *
 * `close()` 是给"连接作废了,但我还没把它交给 Tango"这种情况用的 —— 比如
 * 握手失败之后:那条 TCP 半死不活,不收掉的话它会一直挂着。
 */
export interface AdbTcpConnection extends AdbDaemonConnection {
  close(): void
}

/**
 * 建连接等多久。
 *
 * 不设的话,端口没人听要等操作系统的默认超时(能到一两分钟),界面上就是
 * "点了没反应"。5 秒对同一个 Docker 网桥上的容器足够了。
 */
const CONNECT_TIMEOUT_MS = 5_000

/** 连上容器的 adbd,拿一个可以交给 Tango 的连接。 */
export const connectAdbDaemon = async (
  target: AdbTcpTarget
): Promise<AdbTcpConnection> => {
  const socket = connect({ host: target.host, port: target.port })

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
    )
  } catch (error) {
    socket.destroy()
    throw new AdbConnectFailed(target, error)
  }

  // adb 的包都不大,而且一来一回很快。攒着一起发(Nagle)只会让每条命令
  // 平白多等一个 RTT。
  socket.setNoDelay(true)

  return socketToConnection(socket)
}

const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`等了 ${CONNECT_TIMEOUT_MS} 毫秒没连上`)),
          CONNECT_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 给一条已经连上的 TCP socket 套上 ADB 那层。
 *
 * 两个方向都靠 DuplexStreamFactory 收口:任意一边先断,另一边跟着断。
 * 不这么做的话,用户关掉页面之后这条连接会一直挂着,而 adbd 同时只肯接受
 * 一个客户端 —— 那个容器就再也连不上了。
 */
const socketToConnection = (socket: Socket): AdbTcpConnection => {
  const duplex = new DuplexStreamFactory<
    AdbPacketData,
    Consumable<AdbPacketInit>
  >({
    // 正常收尾:把自己的写端关掉,让 adbd 知道我们走了。
    close: () => {
      socket.end()
    },
    // 兜底清理:对面已经没了,直接扔掉这条 socket。
    dispose: () => {
      socket.destroy()
    },
  })

  // 这条连接已经不可用了(写不出去、或者外面要收掉它)。读端跟着关掉,
  // socket 直接扔。Tango 那边会看到流结束,把 disconnected 定下来。
  const broken = (): void => {
    void duplex.dispose().catch(() => {})
  }

  const readable = duplex.wrapReadable(
    tcpByteStream(socket).pipeThrough(new StructDeserializeStream(AdbPacket))
  )

  const writable = duplex.createWritable(packetWritable(socket, broken))

  return { readable, writable, close: broken }
}

/**
 * ADB 包 -> socket 上的字节。
 *
 * 这里刻意把"写失败"当连接级的事处理,而不是把错误扔回给写的人:
 *
 *   - 写失败(EPIPE、ERR_STREAM_DESTROYED……)只说明这条 TCP 没了。往上报
 *     的话,错误会穿过 Tango 内部好几处没人接的 Promise(它自己的分包
 *     管道、Consumable 的 consumed),变成 unhandled rejection —— 在 Node
 *     上这等于直接崩进程,一整台服务上跑的容器全跟着遭殃。
 *   - 所以这里把它收掉,改成"整条连接收工":readable 那头跟着结束,Tango
 *     把 disconnected 定下来,上层(AdbSessions)看到的就是"连接断了",
 *     下次要用会重新连。这才是调用方真正需要知道的事。
 *
 * 注意 sink 的 write 永远不能 reject —— Tango 给每个包套了一层 Consumable,
 * 它的写入方只在 write 成功之后才去 await `consumed`;write 一 reject,
 * 那个 rejected 的 `consumed` 就没人接了,又是一次崩进程。
 */
const packetWritable = (
  socket: Socket,
  broken: () => void
): WritableStream<Consumable<AdbPacketInit>> => {
  // 复用同一块头,和官方那条序列化流一样 —— 每写一笔都要等 socket 收下
  // (见 writeToSocket),所以下一笔来的时候它已经没用了。
  const header = new Uint8Array(AdbPacketHeader.size)

  return new WritableStream<Consumable<AdbPacketInit>>({
    write: async (packet) => {
      try {
        await packet.tryConsume(async (init) => {
          const fields = init as AdbPacketInit & { payloadLength: number }
          fields.payloadLength = fields.payload.length
          AdbPacketHeader.serialize(fields, header)

          if (!(await writeToSocket(socket, header))) return broken()
          if (fields.payload.length === 0) return
          if (!(await writeToSocket(socket, fields.payload))) broken()
        })
      } catch {
        // 包自己序列化不出来,是我们这边的问题,但也不该把进程带走:
        // 当作连接坏了,写入方看到的是断开。
        broken()
      }
    },
  })
}

/** 往 socket 里写一块字节。false 表示这条连接已经写不动了。 */
const writeToSocket = (socket: Socket, chunk: Uint8Array): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    try {
      socket.write(chunk, (error) =>
        resolve(error === undefined || error === null)
      )
    } catch {
      resolve(false)
    }
  })

/**
 * socket 的数据事件 -> 字节流。
 *
 * 收到一块就先 pause,等下游(也就是 ADB 的包解析和上面的业务)把这块消化
 * 掉再 resume。没有这一步的话,一个 `adb pull` 大文件就能把内存堆满。
 */
const tcpByteStream = (socket: Socket) =>
  new PushReadableStream<Uint8Array>((controller) => {
    socket.on("data", (chunk) => {
      socket.pause()
      void controller
        .enqueue(chunk)
        .then((enqueued) => {
          if (enqueued) socket.resume()
        })
        // 流已经收掉了(比如这条连接被判死)时 enqueue 会抛。数据丢了就
        // 丢了 —— 连接本来就已经没了,不能让它变成没人处理的拒绝。
        .catch(() => {})
    })
    socket.on("end", () => controller.close())
    socket.on("error", (error) => controller.error(error))
    controller.abortSignal.addEventListener("abort", () => socket.destroy())
  })
