import type { AdbFeature } from "@yume-chan/adb"
import { Adb, AdbBanner } from "@yume-chan/adb"
import { fetchAdbInfo } from "../api"
import { AdbWebSocketTransport } from "./transport"

/**
 * 后端转发用的地址。
 *
 * 协议跟着页面走:反代上面是 https 的时候必须 wss,不然浏览器直接拒连。
 * 同源(同一个 host、同一个端口)是刻意的 —— 这个程序对外只开一个口,
 * 页面、接口、adb 通道都从那一个口进出。
 */
export const adbSocketUrl = (containerId: string, service: string): string =>
  `${
    location.protocol === "https:" ? "wss:" : "ws:"
  }//${location.host}/api/containers/${encodeURIComponent(
    containerId
  )}/adb/ws?service=${encodeURIComponent(service)}`

/**
 * 连上容器里的 Android,拿到一个能直接用的 Adb 实例。
 *
 * 这里只做两件事:问后端要握手信息,把 transport 装出来。真正的连接是
 * 懒的 —— 第一条 ADB socket 被用到的时候才开 WebSocket。所以这个函数几乎
 * 不会失败,失败也是"容器没在跑"这种在拿信息那一步就暴露出来的问题。
 */
export const connectContainer = async (containerId: string): Promise<Adb> => {
  const info = await fetchAdbInfo(containerId)

  const transport = new AdbWebSocketTransport({
    serial: info.serial,
    maxPayloadSize: info.maxPayloadSize,
    banner: new AdbBanner(
      undefined,
      info.banner.product,
      info.banner.model,
      info.banner.device,
      info.banner.features as readonly AdbFeature[]
    ),
    // 后端握手时用的那份 feature 列表,原样带过来 —— Tango 靠它决定某些
    // 命令怎么发(比如 shell 用 v1 还是 v2),两边必须一致。
    clientFeatures: info.clientFeatures as readonly AdbFeature[],
    url: (service) => adbSocketUrl(containerId, service),
  })

  return new Adb(transport)
}
