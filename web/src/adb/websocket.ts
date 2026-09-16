import type {
  MaybeConsumable,
  ReadableStream,
  WritableStream,
} from "@yume-chan/stream-extra"
import {
  Consumable,
  PushReadableStream,
  WritableStream as WritableStreamImpl,
} from "@yume-chan/stream-extra"

/**
 * 一条 WebSocket,当 Tango 要的字节流用。
 *
 * Tango 从头到尾用 Web Streams(ReadableStream / WritableStream),而浏览器
 * 给的是事件 API(onopen / onmessage / onclose)。这一层只干这一件事。
 *
 * 一条 WS 对应设备上一条 ADB socket:后端收到连接就替我们开 socket,关掉
 * WS 就等于关掉那条 socket。所以"一条 WS 一条 socket"不是随便定的规矩,
 * 是这条链路上的最小单位。
 */

export interface AdbWebSocketLink {
  /**
   * WebSocket 握手成功。连不上时以**后端给的理由** reject —— 后端在关掉
   * 连接之前会把原因写进 close 帧(比如"容器没在跑"),那是唯一能拿到
   * "为什么连不上"的地方,不能丢。
   */
  readonly opened: Promise<void>
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<MaybeConsumable<Uint8Array>>
  readonly closed: Promise<undefined>
  close(): void
}

/** 攒到这么多字节就先别发了,等对面消化一点。 */
const BUFFER_LIMIT = 4 * 1024 * 1024

const DRAIN_INTERVAL_MS = 10

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const openAdbWebSocket = (url: string): AdbWebSocketLink => {
  const socket = new WebSocket(url)
  // 不设这个的话二进制消息以 Blob 到达,还得异步再读一遍才能用。
  socket.binaryType = "arraybuffer"

  let openedSettled = false
  let settleOpened: (error: Error | null) => void = () => {}
  const opened = new Promise<void>((resolve, reject) => {
    settleOpened = (error) => {
      if (openedSettled) return
      openedSettled = true
      if (error === null) resolve()
      else reject(error)
    }
  })

  let settleClosed: () => void = () => {}
  const closed = new Promise<undefined>((resolve) => {
    settleClosed = () => resolve(undefined)
  })

  const readable = new PushReadableStream<Uint8Array>((controller) => {
    socket.addEventListener("message", (event) => {
      // 后端只发二进制。文本消息不该出现,真出现了当没收到 —— 往 ADB 的
      // 字节流里塞字符串没有意义。
      if (typeof event.data === "string") return
      void controller.enqueue(new Uint8Array(event.data as ArrayBuffer))
    })
    socket.addEventListener("close", () => controller.close())
    socket.addEventListener("error", () =>
      controller.error(new Error("WebSocket 出错"))
    )
  })

  const send = async (chunk: Uint8Array): Promise<void> => {
    // 对面读得慢就等一等。屏幕那一路是持续推流的,不拦着的话内存里会堆下
    // 越来越多的帧,最后整个标签页卡死。
    while (socket.bufferedAmount > BUFFER_LIMIT) await wait(DRAIN_INTERVAL_MS)
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(chunk as Uint8Array<ArrayBuffer>)
  }

  const writable = new WritableStreamImpl<MaybeConsumable<Uint8Array>>({
    // 写进来的可能是普通字节,也可能是一块"用完要打招呼"的缓冲区 ——
    // Tango 推大文件时会用后者。两种都得处理,而且都要等发出去才算用完,
    // 不然那块内存会被提前回收。
    async write(chunk) {
      await (chunk instanceof Consumable
        ? chunk.tryConsume(send)
        : send(chunk))
    },
  })

  socket.addEventListener("open", () => settleOpened(null))
  socket.addEventListener("close", (event) => {
    // 还没连上就关了 = 后端拒绝了。理由在 close 帧的说明里,原样带出去。
    settleOpened(
      new Error(
        event.reason !== ""
          ? event.reason
          : `连接被关掉了(代码 ${event.code})`
      )
    )
    settleClosed()
  })

  return {
    opened,
    readable,
    writable,
    closed,
    close: () => socket.close(),
  }
}
