import type Docker from "dockerode"
import { Adb, adbDaemonAuthenticate } from "@yume-chan/adb"
import { findRedroidAdbPort } from "../containers.js"
import type { DockerEndpoint } from "../docker-host.js"
import { connectAdbDaemon, type AdbTcpTarget } from "./connection.js"
import { createCredentialManager } from "./credentials.js"

/**
 * 每个容器一条到 adbd 的长连接,大家共用。
 *
 * 为什么必须共用:adbd **同时只接受一个客户端**。容器里的 adb 是给整个
 * Android 服务的,不是"一个用户一条"。后端要是每来一个请求就连一次,那么
 * 两个用户同时看屏幕时,后连上的那个会把前一个挤掉。所以这里按容器缓存,
 * 所有会话(浏览器的每个 ADB socket)都从这一条里开子通道(multiplexing)。
 *
 * 为什么又要放掉:那条唯一的客户端名额被后端一直占着的话,用户自己在宿主上
 * 跑 `adb connect 127.0.0.1:5555` 就挤不进来。所以最后一个借用人走了之后再
 * 等一会儿就关掉 —— 留这一会儿是为了让 scrcpy 那几条一前一后打开的 socket
 * 复用同一条连接,不至于来回重连。
 */

/** 没人用了之后还留多久。 */
const IDLE_TIMEOUT_MS = 30_000

export interface AdbSessionOptions {
  readonly docker: Docker
  readonly endpoint: DockerEndpoint
  /**
   * 从哪台机器去连容器的 adb 端口。
   *
   * null 表示"跟着容器的绑定地址走"(见 #hostFor);后端跑在容器里时,得
   * 显式指到宿主那边(例如 host.docker.internal),否则 127.0.0.1 指的是
   * 后端容器自己。
   */
  readonly host: string | null
}

/**
 * 借来的一条连接。用完必须 release —— 不 release 的话连接会一直被占着,
 * 而且借用人计数只增不减,后面再也没人放得掉它。
 */
export interface AdbLease {
  readonly adb: Adb
  release(): void
}

interface Entry {
  /** 连上之后的 Adb;连的过程中是 null */
  adb: Adb | null
  /** 连接创建过程。失败时 acquire 会把它从表里删掉,下次重连 */
  readonly connecting: Promise<Adb>
  /** 现在有几个借用人 */
  leases: number
  /** 没人用之后的倒计时;有人在用就是 null */
  idleTimer: NodeJS.Timeout | null
}

export class AdbSessions {
  readonly #docker: Docker
  readonly #endpoint: DockerEndpoint
  readonly #host: string | null
  readonly #entries = new Map<string, Entry>()

  constructor(options: AdbSessionOptions) {
    this.#docker = options.docker
    this.#endpoint = options.endpoint
    this.#host = options.host
  }

  async acquire(id: string): Promise<AdbLease> {
    // 拿到连接的过程中它可能已经断了(或者容器被人停了),那时手上这条就是
    // 废的 —— 重新借一次。最多重试一次:反复失败说明是真连不上,该把错误
    // 抛给调用者,而不是在这里转圈。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entry = this.#entry(id)
      this.#hold(entry)

      let adb: Adb
      try {
        adb = await entry.connecting
      } catch (error) {
        this.#discard(id, entry)
        throw error
      }

      // 等的时候被放掉了(断线、容器被停、进程在收尾),这个 await 拿到的是
      // 一条已经关掉的连接。当没发生过,再来一次。
      if (this.#entries.get(id) !== entry) {
        this.#release(id, entry)
        continue
      }

      let released = false
      return {
        adb,
        release: () => {
          if (released) return
          released = true
          this.#release(id, entry)
        },
      }
    }

    throw new Error(`借不到 ${id} 的 adb 连接`)
  }

  /**
   * 把这个容器的连接扔掉,下次用到时重新连。
   *
   * 容器被停掉/删掉时必须调 —— 连接虽然会自己断,但表里那条记录得清掉,
   * 否则新起的同名容器会拿到一条指向旧地址的死连接。
   */
  forget(id: string): void {
    const entry = this.#entries.get(id)
    if (entry === undefined) return

    this.#entries.delete(id)
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    this.#close(entry)
  }

  /** 进程收尾:把所有连接都放掉。 */
  close(): void {
    for (const id of [...this.#entries.keys()]) this.forget(id)
  }

  /* ---------- 内部实现 ---------- */

  #entry(id: string): Entry {
    const existing = this.#entries.get(id)
    if (existing !== undefined) return existing

    const entry: Entry = {
      adb: null,
      connecting: this.#connect(id),
      leases: 0,
      idleTimer: null,
    }
    this.#entries.set(id, entry)

    void entry.connecting.then(
      (adb) => {
        entry.adb = adb
        this.#watchDisconnect(id, entry, adb)
      },
      // 连接失败由 acquire 那边 await 出来,这里只负责别让这个 then 分支
      // 自己变成 unhandled rejection。
      () => {}
    )

    return entry
  }

  #hold(entry: Entry): void {
    entry.leases += 1
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  #release(id: string, entry: Entry): void {
    entry.leases -= 1
    if (entry.leases > 0) return
    if (this.#entries.get(id) !== entry) return

    entry.idleTimer = setTimeout(() => this.forget(id), IDLE_TIMEOUT_MS)
    // 只剩这个定时器的话不该拦着进程退出(尤其是进程正在收尾的时候)。
    entry.idleTimer.unref()
  }

  /** 从表里拿掉但不去关连接 —— 连接已经断了,或者正在断。 */
  #discard(id: string, entry: Entry): void {
    if (this.#entries.get(id) !== entry) return
    this.#entries.delete(id)
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
  }

  #close(entry: Entry): void {
    if (entry.adb !== null) {
      void Promise.resolve(entry.adb.close()).catch(() => {})
      return
    }

    // 还在连:等它连上再关。连不上就算了 —— 本来就没东西要关。
    void entry.connecting.then(
      (adb) => adb.close(),
      () => {}
    )
  }

  /**
   * 连接自己断了(容器重启、网络抽风)时把记录清掉,下次用到会重连。
   *
   * 注意要在删之前确认表里还是这条连接:容器被停掉时 forget 先跑,表里已经
   * 换成别人的新连接了,这时候不能再动。
   */
  #watchDisconnect(id: string, entry: Entry, adb: Adb): void {
    // 连接自己断了有两种:对面正常收尾(resolve),或者出错/被掐(resolve
    // 之外还会 reject,比如对面发来一个我们不认识的包)。两种的处理一样 ——
    // 把记录清掉,下次用到重新连。**reject 必须接住**:不接的话它就是一个
    // 没人处理的 Promise 拒绝,在 Node 上会直接把整个进程带崩。
    const drop = () => {
      if (this.#entries.get(id) !== entry) return
      this.#discard(id, entry)
    }
    void adb.disconnected.then(drop, drop)
  }

  async #connect(id: string): Promise<Adb> {
    const { port, bindAddress } = await findRedroidAdbPort(
      this.#docker,
      this.#endpoint,
      id
    )

    const target: AdbTcpTarget = { host: this.#hostFor(bindAddress), port }
    const connection = await connectAdbDaemon(target)

    const transport = await adbDaemonAuthenticate({
      // 这个名字只用来给人看(出错时的提示、以后界面上显示),Google 的 adb
      // 对 TCP 设备用的也是这个格式。
      serial: `${target.host}:${target.port}`,
      connection,
      credentialManager: createCredentialManager(),
    })

    return new Adb(transport)
  }

  /**
   * 后端该往哪个地址连。
   *
   * 配了 REDROID_WEB_ADB_HOST 就用配的;没配就跟着容器绑定的地址走 ——
   * 绑在 127.0.0.1 就连 127.0.0.1,绑在 0.0.0.0(所有网卡)也从 127.0.0.1
   * 连(一定通,而且不用出网卡)。绑在某个具体地址上的话就用那个地址:那种
   * 情况下容器只接受从那块网卡进来的连接。
   */
  #hostFor(bindAddress: string | null): string {
    if (this.#host !== null) return this.#host
    if (bindAddress === null || bindAddress === "0.0.0.0") return "127.0.0.1"
    return bindAddress
  }
}
