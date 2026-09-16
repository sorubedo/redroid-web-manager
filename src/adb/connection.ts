import { connect, type Socket } from "node:net"
import type {
  AdbDaemonConnection,
  AdbPacketData,
  AdbPacketInit,
} from "@yume-chan/adb"
import { AdbPacket, AdbPacketSerializeStream } from "@yume-chan/adb"
import type { Consumable } from "@yume-chan/stream-extra"
import {
  DuplexStreamFactory,
  MaybeConsumable,
  PushReadableStream,
  StructDeserializeStream,
  pipeFrom,
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
 * 连不上容器的 adb 端口。
 *
 * 最常见的两种原因:容器没在跑,或者它的 5555 没有发布到宿主上。
 * 消息里带上地址,是因为"哪个容器"这件事调用者已经知道了 —— 报错只要说
 * 清楚"去哪儿找它没找着"。
 */
export class AdbConnectFailed extends Error {
  readonly target: AdbTcpTarget

  constructor(target: AdbTcpTarget, cause: unknown) {
    super(
      `连不上 ${target.host}:${target.port} 上的 adb:${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    )
    this.name = "AdbConnectFailed"
    this.target = target
  }
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
): Promise<AdbDaemonConnection> => {
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
const socketToConnection = (socket: Socket): AdbDaemonConnection => {
  const duplex = new DuplexStreamFactory<
    AdbPacketData,
    Consumable<Uint8Array>
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

  const readable = duplex.wrapReadable(
    tcpByteStream(socket).pipeThrough(new StructDeserializeStream(AdbPacket))
  )

  const writable = pipeFrom(
    duplex.createWritable(
      new MaybeConsumable.WritableStream<Uint8Array>({
        write: (chunk) =>
          new Promise<void>((resolve, reject) => {
            socket.write(chunk, (error) => (error ? reject(error) : resolve()))
          }),
      })
    ),
    new AdbPacketSerializeStream()
  )

  return { readable, writable }
}

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
      void controller.enqueue(chunk).then(() => socket.resume())
    })
    socket.on("end", () => controller.close())
    socket.on("error", (error) => controller.error(error))
    controller.abortSignal.addEventListener("abort", () => socket.destroy())
  })
