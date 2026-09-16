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
  ScrcpyInstanceId,
  ScrcpyPointerId,
} from "@yume-chan/scrcpy"
import {
  BitmapVideoFrameRenderer,
  type CanvasVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs"
import { ApiFailure } from "../api"

// 浏览器里的 scrcpy 客户端。
//
// 一条完整链路是:推 scrcpy-server 到设备 -> 用 app_process 起它 -> 连它开
// 的三个 socket(视频/控制)-> 把视频流喂给 WebCodecs 解码 -> 画到 canvas
// 上;手指的动作反过来编成控制消息发回去。
//
// 这些 socket 全都走前面那条 WebSocket 通道,所以后端只看到字节。
// scrcpy 默认走 `adb reverse`(要客户端先在本机监听一个端口),浏览器做不到,
// Tango 发现 reverse 不被支持会自动改用 forward 隧道 —— 也就是直接连设备上
// 的 socket,正好是我们要的。

/** 必须和 src/scrcpy-server.ts 里的版本一致。 */
const SCRCPY_VERSION = "4.1"

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

/**
 * 起一个 scrcpy 会话:推 jar、拉起 server、连上它的视频流。
 *
 * 到这一步为止都不需要浏览器(解码才需要),所以单独拆出来 —— Node 里也能
 * 直接用它验证并发这类事。
 */
export const startScrcpySession = async (adb: Adb) => {
  const jar = await fetchServerJar()

  // 每个会话一个 scid。scrcpy 用它给 socket 起名(localabstract:scrcpy_xxxxxxxx);
  // 不指定的话所有实例都绑同一个名字,同时打开时后一个会直接
  // `Address already in use` 退出 —— 于是多个页面只是接到了同一个 server 的
  // 流上:看着"也行",但同一瞬间点两下就有一个打不开。
  const scid = ScrcpyInstanceId.random()
  const scidHex = scid.value.toString(16).padStart(8, "0")

  // jar 也按会话分开:同一个文件被两个会话同时写会串(ADB 的 sync 不是原子的)。
  // server 退出时会删掉自己那一份(路径是它从 classpath 推出来的),不会攒垃圾。
  const serverPath = DefaultServerPath.replace(/\.jar$/, `-${scidHex}.jar`)
  await AdbScrcpyClient.pushServer(adb, jar, serverPath)

  const client = await AdbScrcpyClient.start(
    adb,
    serverPath,
    new AdbScrcpyOptionsLatest({
      video: true,
      // 声音先不要:浏览器这边要额外接一个解码器和播放器,而且容器里
      // 那台"手机"多数时候也没人听。
      audio: false,
      control: true,
      // 4.1 把编码格式做成了必填项(以前有默认值)。
      videoCodec: "h264",
      maxSize: DEFAULT_MAX_SIZE,
      videoBitRate: VIDEO_BIT_RATE,
      scid,
    })
  )

  const video = await client.videoStream
  if (video === undefined) {
    await client.close()
    throw new Error("scrcpy 没有给出视频流")
  }

  return { client, video }
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

    const { client, video } = await startScrcpySession(adb)

    // WebGL 那条路要 GPU,拿不到就退回 2D 画布。两者的接口一样。
    const renderer: CanvasVideoFrameRenderer =
      WebGLVideoFrameRenderer.isSupported
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

  readonly #client: AdbScrcpyClient<AdbScrcpyOptionsLatest>
  readonly #decoder: WebCodecsVideoDecoder
  readonly #renderer: CanvasVideoFrameRenderer

  #closed = false

  private constructor(
    client: AdbScrcpyClient<AdbScrcpyOptionsLatest>,
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

  /**
   * 让设备转 90 度。
   *
   * 这是 scrcpy 的"请设备旋转"控制消息:它冻结当前显示方向并换成另一个。
   * 是不是立刻看得见取决于当前在前台的应用 —— 锁竖屏的界面(桌面、设置)
   * 不会跟着转,支持横屏的应用(相册、视频)会。和按设备上的自动旋转键
   * 是一回事,不是这个按钮的毛病。
   */
  rotate(): void {
    const controller = this.#client.controller
    if (controller === undefined || this.#closed) return
    void controller.rotateDevice()
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
      typeof detail?.message === "string"
        ? detail.message
        : "拿不到 scrcpy 的 server",
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
