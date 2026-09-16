import type { Adb } from "@yume-chan/adb"
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy"
import type { MaybeConsumable, ReadableStream } from "@yume-chan/stream-extra"
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  DefaultServerPath,
  ScrcpyPointerId,
} from "@yume-chan/scrcpy"
import {
  BitmapVideoFrameRenderer,
  type CanvasVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs"
import { ApiFailure } from "../api"

/**
 * 浏览器里的 scrcpy 客户端。
 *
 * 一条完整链路是:推 scrcpy-server 到设备 -> 用 app_process 起它 -> 连它开
 * 的三个 socket(视频/控制)-> 把视频流喂给 WebCodecs 解码 -> 画到 canvas
 * 上;手指的动作反过来编成控制消息发回去。
 *
 * 这些 socket 全都走前面那条 WebSocket 通道,所以后端只看到字节。
 * scrcpy 默认走 `adb reverse`(要客户端先在本机监听一个端口),浏览器做不到,
 * Tango 发现 reverse 不被支持会自动改用 forward 隧道 —— 也就是直接连设备上
 * 的 `localabstract:scrcpy`,正好是我们要的。
 */

/** 必须和 src/scrcpy-server.ts 里的版本一致。 */
const SCRCPY_VERSION = "3.3.3"

/** 画面最大边长。手机上 1080 的原生分辨率推到浏览器上,流量和 CPU 都不划算。 */
const DEFAULT_MAX_SIZE = 1280

/** 码率,单位是比特每秒(scrcpy 的参数表就是这个单位)。 */
const VIDEO_BIT_RATE = 4_000_000

export interface ScreenSize {
  readonly width: number
  readonly height: number
}

export type TouchAction = "down" | "move" | "up"

export class ScrcpyUnsupported extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScrcpyUnsupported"
  }
}

export class ScrcpyScreen {
  /** 这个浏览器能不能解视频。解不了就别开这个界面了。 */
  static get isSupported(): boolean {
    return WebCodecsVideoDecoder.isSupported
  }

  static async start(adb: Adb): Promise<ScrcpyScreen> {
    if (!WebCodecsVideoDecoder.isSupported) {
      throw new ScrcpyUnsupported(
        "这个浏览器没有 WebCodecs,解不了 scrcpy 的视频流。换 Chrome 或 Edge 试试。"
      )
    }

    const jar = await fetchServerJar()
    // 90KB,每次会话推一遍。设备重启会清掉 /data/local/tmp,为省这点流量
    // 去做"文件在不在"的判断不值当。
    await AdbScrcpyClient.pushServer(adb, jar)

    const client = await AdbScrcpyClient.start(
      adb,
      DefaultServerPath,
      new AdbScrcpyOptionsLatest({
        video: true,
        // 声音先不要:浏览器这边要额外接一个解码器和播放器,而且容器里
        // 那台"手机"多数时候也没人听。
        audio: false,
        control: true,
        maxSize: DEFAULT_MAX_SIZE,
        videoBitRate: VIDEO_BIT_RATE,
      })
    )

    const video = await client.videoStream
    if (video === undefined) throw new Error("scrcpy 没有给出视频流")

    // WebGL 那条路要 GPU,拿不到就退回 2D 画布。两者的接口一样。
    const renderer: CanvasVideoFrameRenderer = WebGLVideoFrameRenderer.isSupported
      ? new WebGLVideoFrameRenderer()
      : new BitmapVideoFrameRenderer()
    const decoder = new WebCodecsVideoDecoder({
      codec: video.metadata.codec,
      renderer,
    })

    // 这条 pipe 一直跑到会话结束。关掉之后再去读会抛,所以不接它的结果 ——
    // 真正的错误会从 client.exited 那边冒出来。
    void video.stream.pipeTo(decoder.writable).catch(() => {})

    return new ScrcpyScreen(client, decoder, renderer)
  }

  readonly #client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>
  readonly #decoder: WebCodecsVideoDecoder
  readonly #renderer: CanvasVideoFrameRenderer

  #closed = false

  private constructor(
    client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>,
    decoder: WebCodecsVideoDecoder,
    renderer: CanvasVideoFrameRenderer
  ) {
    this.#client = client
    this.#decoder = decoder
    this.#renderer = renderer
  }

  get canvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.#renderer.canvas
  }

  get size(): ScreenSize {
    return { width: this.#decoder.width, height: this.#decoder.height }
  }

  /** 画面尺寸变了(旋转、改分辨率)。返回一个取消订阅的函数。 */
  onSizeChanged(listener: (size: ScreenSize) => void): () => void {
    const subscription = this.#decoder.sizeChanged((size) => listener(size))
    return () => subscription.dispose()
  }

  /** scrcpy 的 server 自己退了(容器重启、被杀),界面该收摊了。 */
  onExited(listener: () => void): void {
    void this.#client.exited.then(
      () => listener(),
      () => listener()
    )
  }

  touch(action: TouchAction, pointerX: number, pointerY: number): void {
    const controller = this.#client.controller
    if (controller === undefined || this.#closed) return

    const { width, height } = this.size
    const up = action === "up"
    void controller.injectTouch({
      action: up
        ? AndroidMotionEventAction.Up
        : action === "down"
          ? AndroidMotionEventAction.Down
          : AndroidMotionEventAction.Move,
      pointerId: ScrcpyPointerId.Finger,
      pointerX,
      pointerY,
      videoWidth: width,
      videoHeight: height,
      pressure: up ? 0 : 1,
      // 触发这次动作的是哪个"键"(鼠标键)。手指触摸是 0。
      actionButton: AndroidMotionEventButton.None,
      buttons: up
        ? AndroidMotionEventButton.None
        : AndroidMotionEventButton.Primary,
    })
  }

  /** 滚轮。dx/dy 是像素,scrcpy 要的是相对画面的比例。 */
  scroll(pointerX: number, pointerY: number, dx: number, dy: number): void {
    const controller = this.#client.controller
    if (controller === undefined || this.#closed) return

    const { width, height } = this.size
    if (width === 0 || height === 0) return
    void controller.injectScroll({
      pointerX,
      pointerY,
      videoWidth: width,
      videoHeight: height,
      // 往前滚(手指往上)画面往下走,所以符号反一下。
      scrollX: -dx / width,
      scrollY: -dy / height,
      buttons: AndroidMotionEventButton.None,
    })
  }

  /** 一个键的按下或抬起。 */
  key(keyCode: AndroidKeyCode, action: AndroidKeyEventAction): void {
    const controller = this.#client.controller
    if (controller === undefined || this.#closed) return
    void controller.injectKeyCode({
      action,
      keyCode,
      repeat: 0,
      metaState: AndroidKeyEventMeta.None,
    })
  }

  /** 直接敲一下某个键(按下再抬起)。 */
  tapKey(keyCode: AndroidKeyCode): void {
    this.key(keyCode, AndroidKeyEventAction.Down)
    this.key(keyCode, AndroidKeyEventAction.Up)
  }

  /** 把一段文字送进设备。走的是 scrcpy 的注入文本,不经过按键映射。 */
  text(text: string): void {
    const controller = this.#client.controller
    if (controller === undefined || this.#closed || text === "") return
    void controller.injectText(text)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#decoder.dispose()
    await this.#client.close()
  }
}

/**
 * 后端缓存的那份 scrcpy-server。
 *
 * 返回类型得顺着 Tango 要的那一套写:stream-extra 里"它包的 DOM 类型"和
 * "它继承的全局类"是两个不兼容的声明(closed 的返回差一个 undefined),
 * 运行期是同一个东西,所以这里只做一次类型转换。
 */
const fetchServerJar = async (): Promise<
  ReadableStream<MaybeConsumable<Uint8Array>>
> => {
  let response: Response
  try {
    response = await fetch("/api/scrcpy/server")
  } catch {
    throw new ApiFailure(
      "连不上后端",
      "确认后端还在跑 —— 终端里应该有「✓ 后端已启动」那一行。"
    )
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const detail = body as { message?: unknown; hint?: unknown } | null
    throw new ApiFailure(
      typeof detail?.message === "string" ? detail.message : "拿不到 scrcpy 的 server",
      typeof detail?.hint === "string" ? detail.hint : ""
    )
  }

  const version = response.headers.get("X-Scrcpy-Version")
  if (version !== null && version !== SCRCPY_VERSION) {
    // 版本对不上时最坏的情况是"能连上但画面是花的",查起来很费劲。
    // 这里直接拦住,让它变成一个明确的错误。
    throw new ScrcpyUnsupported(
      `后端给的是 scrcpy ${version},前端只认 ${SCRCPY_VERSION}。两边得一起升级。`
    )
  }

  if (response.body === null) {
    throw new ApiFailure("后端没有给出 jar 的内容", "")
  }
  return response.body as unknown as ReadableStream<
    MaybeConsumable<Uint8Array>
  >
}

/** 返回键。界面上那个「返回」按钮用它。 */
export const AndroidBackKey = AndroidKeyCode.AndroidBack
/** Home 键。 */
export const AndroidHomeKey = AndroidKeyCode.AndroidHome
