import type {
  AdbFeature,
  AdbIncomingSocketHandler,
  AdbSocket,
  AdbTransport,
} from "@yume-chan/adb"
import { AdbReverseNotSupportedError, type AdbBanner } from "@yume-chan/adb"
import { openAdbWebSocket, type AdbWebSocketLink } from "./websocket"

/**
 * 浏览器这边的 AdbTransport:每次要一条 ADB socket,就往后端开一条
 * WebSocket,后端在共用的那条 adbd 连接上替我们开。
 *
 * 握手、认证、多路复用、feature 协商全是后端做的 —— banner /
 * maxPayloadSize / clientFeatures 都由后端在握手时问出来再转告我们,浏览器
 * 自己够不到 adbd。于是这边拿到的是一个**完整的 Adb 实例**:shell、推文件、
 * scrcpy 全都跟本地一样用,只是字节要绕一圈后端。
 *
 * 这就是"方案 A"的意思:后端只搬字节,不解释 ADB 协议,能做什么完全由
 * 前端决定。
 */
export interface AdbWebSocketTransportOptions {
  readonly serial: string
  readonly maxPayloadSize: number
  readonly banner: AdbBanner
  readonly clientFeatures: readonly AdbFeature[]
  /** service 字符串 -> 该连哪条 WebSocket */
  readonly url: (service: string) => string
}

export class AdbWebSocketTransport implements AdbTransport {
  readonly serial: string
  readonly maxPayloadSize: number
  readonly banner: AdbBanner
  readonly clientFeatures: readonly AdbFeature[]

  readonly #url: (service: string) => string
  readonly #sockets = new Set<AdbWebSocketLink>()

  #settleDisconnected: () => void = () => {}
  readonly #disconnected = new Promise<void>((resolve) => {
    this.#settleDisconnected = resolve
  })

  constructor(options: AdbWebSocketTransportOptions) {
    this.serial = options.serial
    this.maxPayloadSize = options.maxPayloadSize
    this.banner = options.banner
    this.clientFeatures = options.clientFeatures
    this.#url = options.url
  }

  get disconnected(): Promise<void> {
    return this.#disconnected
  }

  async connect(service: string): Promise<AdbSocket> {
    const link = openAdbWebSocket(this.#url(service))
    // 打不开就抛出去,让调用方(界面)拿到后端的原话。
    await link.opened

    this.#sockets.add(link)
    void link.closed.then(() => this.#sockets.delete(link))

    return {
      service,
      readable: link.readable,
      writable: link.writable,
      get closed() {
        return link.closed
      },
      close: () => link.close(),
    }
  }

  // 反向隧道(adb reverse)要在这边先监听一个端口,浏览器做不到。
  // scrcpy 发现 reverse 不行会退而求其次改用 forward 隧道,所以这不是死路。
  addReverseTunnel(
    _handler: AdbIncomingSocketHandler,
    _address?: string
  ): never {
    throw new AdbReverseNotSupportedError()
  }

  removeReverseTunnel(_address: string): never {
    throw new AdbReverseNotSupportedError()
  }

  clearReverseTunnels(): never {
    throw new AdbReverseNotSupportedError()
  }

  close(): void {
    this.#settleDisconnected()
    for (const socket of this.#sockets) socket.close()
    this.#sockets.clear()
  }
}
