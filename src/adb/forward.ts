import { setTimeout as delay } from "node:timers/promises"
import type { Adb } from "@yume-chan/adb"

/**
 * 把浏览器的一条 WebSocket 接到设备的一条 ADB socket 上。
 *
 * 这是"方案 A"的核心,也是唯一一处把 ADB 的字节流往浏览器递的地方:
 *
 *   浏览器(跑 Tango:握手、scrcpy 协议、解码都在那边)
 *        |  WebSocket,一条对应一个 ADB socket
 *        v
 *   后端(这里,只搬字节)
 *        |  在共用的那条 adb 连接上再开一条 socket
 *        v
 *   容器的 adbd
 *
 * 粒度是 ADB 的 socket(service 字符串,比如 `shell:ls`、`sync:`、
 * `localabstract:scrcpy`),不是把 5555 端口原样转发出去 —— 浏览器拿到的是
 * "能在这个容器上执行任意 adb 命令",这正是方案 A 有意选的:后端不鉴权,
 * 连上就是超级管理员。
 *
 * 这个模块不认 WebSocket 也不认 HTTP,只认下面这个 AdbForwardSink ——
 * 这样它能脱离服务器单独测,也免得把 ws 的类型拖进来。
 */

export interface AdbForwardSink {
  /**
   * 已经发出去、但还没真正写进网络的字节数。
   *
   * 有这个才能做背压:浏览器那边慢(网络差、或者解码卡住),ADB 这边还一个
   * 劲儿地推,不拦着的话内存里会堆下整个屏幕的帧。
   */
  readonly bufferedAmount: number
  send(chunk: Uint8Array): void
  close(): void
  onMessage(listener: (chunk: Uint8Array) => void): void
  onClose(listener: () => void): void
}

/** 攒到这么多字节就等一等,别把浏览器的接收缓冲撑爆。 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/** 等浏览器消费的时候多久看一眼。 */
const DRAIN_INTERVAL_MS = 10

/**
 * 搬运一条 socket,直到任意一边结束。
 *
 * 打开 socket 失败(比如设备不认识这个 service)会把错误抛给调用者;
 * 打开之后的断开都不算错误 —— 用户关页面、容器重启都是家常便饭。
 */
export const forwardAdbSocket = async (
  sink: AdbForwardSink,
  adb: Adb,
  service: string
): Promise<void> => {
  const socket = await openSocket(adb, service)
  const writer = socket.writable.getWriter()

  let closed = false
  const shutdown = (): void => {
    if (closed) return
    closed = true
    void Promise.resolve(socket.close()).catch(() => {})
    sink.close()
  }

  sink.onClose(shutdown)

  // 浏览器 -> 设备。一条排队等上一条写完,不然消息的顺序会被 await 打乱,
  // 而 ADB 的协议是按顺序解析的(半条命令 + 半条命令 = 一堆乱码)。
  let pending: Promise<void> = Promise.resolve()
  sink.onMessage((chunk) => {
    pending = pending
      .then(async () => {
        if (closed) return
        await writer.write(chunk)
      })
      .catch(shutdown)
  })

  // 设备 -> 浏览器。这个循环同时也是"连接还活着"的判据:readable 结束,
  // 说明 socket 那头没了。
  try {
    for await (const chunk of socket.readable) {
      while (!closed && sink.bufferedAmount >= MAX_BUFFERED_BYTES) {
        await delay(DRAIN_INTERVAL_MS)
      }
      if (closed) break
      sink.send(chunk)
    }
  } finally {
    shutdown()
  }
}

/**
 * 打开一条 ADB socket。
 *
 * 多盯一个 disconnected:设备还没回 OKAY 的时候连接就断了的话,这个 OPEN
 * 永远不会有结果 —— Tango 收拾断开时不会把还在等的 OPEN 拒掉,直接 await
 * 就是卡死,界面上表现为"画面一直转圈"。所以连接一断就自己抛出去,让调用
 * 方把 WebSocket 关掉、把原因带给用户。
 */
const openSocket = async (adb: Adb, service: string) => {
  const disconnected = adb.disconnected.then(
    () => {
      throw new Error("adb 连接断了")
    },
    (error: unknown) => {
      throw error
    }
  )
  // createSocket 先赢的话,这个拒绝就没人接了 —— 自己咽掉,别让它变成
  // unhandled rejection(在 Node 上那是要崩进程的)。
  void disconnected.catch(() => {})

  return await Promise.race([adb.createSocket(service), disconnected])
}
