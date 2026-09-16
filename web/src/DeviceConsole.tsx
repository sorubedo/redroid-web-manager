import { useCallback, useEffect, useRef, useState } from "react"
import type { Adb } from "@yume-chan/adb"
import { AndroidKeyCode, AndroidKeyEventAction } from "@yume-chan/scrcpy"
import { connectContainer } from "./adb/connect"
import {
  AndroidBackKey,
  AndroidHomeKey,
  ScrcpyScreen,
  type ScreenSize,
} from "./adb/scrcpy"
import { ApiFailure, type RedroidContainer } from "./api"
import {
  Apps,
  ArrowLeft,
  Copy,
  Expand,
  Home,
  Power,
  Refresh,
  Rotate,
  Screen,
  Spinner,
  Terminal,
  Volume,
  VolumeOff,
  X,
} from "./icons"
import { Badge, Button, controlClass, copyText, cx, IconButton } from "./ui"

/**
 * 控制台:整页接管,画面占满剩下的地方。
 *
 * 之前那个塞在弹窗里的版本有两个硬伤,这里都改掉了:
 *
 *  1. 画面被裁。弹窗里给画面套了个 `max-h-[60vh] + overflow-hidden` 的盒子,
 *     竖屏(720×1280)缩到那么宽之后高度远超盒子,于是下半个屏幕被切掉。
 *     现在画面按比例缩放到刚好放得下,而且缩和放都做(见下面 effect 里的
 *     fit())—— 光靠 `max-h-full max-w-full` 只会往下缩,容器变大之后画面
 *     不动,全屏时反而显得更小。
 *  2. 点击位置对不上。坐标是按**外层盒子**的矩形算的,而盒子比画面小 ——
 *     差一个缩放系数,越往边上越离谱。现在一律量 canvas 自己的矩形。
 *
 * ADB 全程走浏览器(前端是一个完整的 Tango Adb 实例),后端只把字节从
 * WebSocket 搬到容器。这意味着**没有鉴权这件事在这里被放大**:能打开这个
 * 界面的人,就等于拿到了容器里 Android 的屏幕和 shell。
 */

interface DeviceConsoleProps {
  readonly container: RedroidContainer
  readonly onClose: () => void
}

interface Facts {
  readonly android: string
  readonly abi: string
}

const toFailure = (error: unknown): { message: string; hint: string } =>
  error instanceof ApiFailure
    ? { message: error.message, hint: error.hint }
    : {
        message: error instanceof Error ? error.message : String(error),
        hint: "",
      }

// 键盘上哪些键该翻译成 Android 的键码。能打出字符的键不走这里 —— 那些
// 直接当文字注入(见下面的 onKeyDown)。这张表只收那些没有字符的键。
const KEY_CODES: Record<string, AndroidKeyCode> = {
  Enter: AndroidKeyCode.Enter,
  Backspace: AndroidKeyCode.Backspace,
  Tab: AndroidKeyCode.Tab,
  Escape: AndroidKeyCode.AndroidBack,
  ArrowUp: AndroidKeyCode.ArrowUp,
  ArrowDown: AndroidKeyCode.ArrowDown,
  ArrowLeft: AndroidKeyCode.ArrowLeft,
  ArrowRight: AndroidKeyCode.ArrowRight,
}

/** 剪贴板内容的一句话摘要,提示条里用。 */
const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
}

export const DeviceConsole = ({ container, onClose }: DeviceConsoleProps) => {
  const [adb, setAdb] = useState<Adb | null>(null)
  const [facts, setFacts] = useState<Facts | null>(null)
  const [failure, setFailure] = useState<{
    message: string
    hint: string
  } | null>(null)

  const [screen, setScreen] = useState<ScrcpyScreen | null>(null)
  const [screenSize, setScreenSize] = useState<ScreenSize | null>(null)
  const [screenGone, setScreenGone] = useState(false)
  // 点「重来一次」时加一,上面的 effect 会重跑一遍。
  const [attempt, setAttempt] = useState(0)

  const [showShell, setShowShell] = useState(false)
  const [muted, setMuted] = useState(false)
  // 设备复制了、但没写进本机剪贴板(页面没 HTTPS、浏览器要用户手势),
  // 就先摆一条,等用户点。
  const [deviceClipboard, setDeviceClipboard] = useState<string | null>(null)
  // 只剩画面:整页只留 canvas,别的都不显示。
  const [screenOnly, setScreenOnly] = useState(false)
  // 一句临时的提示(比如"设备没换方向")。
  const [hint, setHint] = useState<string | null>(null)

  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  // 画面(canvas)挂在它里面,而不是直接挂在 stage 上。canvas 是解码器自己
  // new 出来的,这个 effect 得用 replaceChildren 把它塞进去 —— 直接对 stage
  // 动手的话,React 渲染的那些兄弟节点(比如断连提示)会被一起清掉。
  const canvasHost = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLPreElement>(null)

  const [command, setCommand] = useState("")
  const [output, setOutput] = useState("")
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let cancelled = false
    let opened: Adb | null = null
    let started: ScrcpyScreen | null = null

    setFailure(null)
    setScreen(null)
    setScreenSize(null)
    setScreenGone(false)
    setDeviceClipboard(null)
    setFacts(null)

    void (async () => {
      try {
        const connected = await connectContainer(container.name)
        // StrictMode 下这个 effect 会跑两次,第一次的结果要扔掉 —— 不然会
        // 留下一条没人关的连接(后端那条到 adbd 的连接是所有会话共用的,
        // 浏览器这边漏掉一条,设备上就多一个白跑的 scrcpy 进程)。
        if (cancelled) {
          connected.close()
          return
        }
        opened = connected
        setAdb(connected)

        const [android, abi] = await Promise.all([
          connected.getProp("ro.build.version.release"),
          connected.getProp("ro.product.cpu.abi"),
        ])
        if (!cancelled) setFacts({ android, abi })

        const session = await ScrcpyScreen.start(connected)
        if (cancelled) {
          await session.close()
          return
        }
        started = session
        setScreen(session)
        session.onExited(() => {
          if (!cancelled) setScreenGone(true)
        })
      } catch (error) {
        if (!cancelled) setFailure(toFailure(error))
      }
    })()

    return () => {
      cancelled = true
      void started?.close()
      opened?.close()
    }
  }, [container.name, attempt])

  // 声音跟着按钮走。会话是新起的(重来一次)时也按当前这个状态来。
  useEffect(() => {
    screen?.setMuted(muted)
  }, [screen, muted])

  /**
   * 设备复制了东西(scrcpy 的剪贴板自动同步)。
   *
   * 先试着自己写进本机剪贴板,但浏览器可能不给写(页面不是安全上下文、或者
   * 需要一个用户手势),那就先摆一条出来,等用户自己点。
   */
  useEffect(() => {
    if (screen === null) return
    return screen.onClipboard((text) => {
      void copyText(text).then((copied) => {
        if (copied) {
          setHint(`已同步设备剪贴板到本机:${preview(text)}`)
        } else {
          setDeviceClipboard(text)
        }
      })
    })
  }, [screen])

  /** 本机剪贴板 -> 设备。走 scrcpy 的剪贴板协议,顺手触发一次粘贴。 */
  const pasteToDevice = useCallback(async () => {
    if (screen === null) return

    let text: string | null = null
    try {
      text = await navigator.clipboard.readText()
    } catch {
      // 读不到通常是因为页面不在安全上下文里(局域网 http)。这条路没有别的
      // 办法,只能让用户手动贴一次。
      text = window.prompt(
        "这个页面读不到本机剪贴板(需要 HTTPS 或 localhost)。把要发送到设备的文字贴到下面:"
      )
    }
    if (text === null || text === "") return

    const sent = await screen.setClipboard(text, { paste: true })
    setHint(
      sent
        ? "已把本机的文字粘贴到设备。"
        : "没能把文字送进设备,画面还好吗?"
    )
  }, [screen])

  /**
   * 把解码器的画布挂进页面,顺便把输入接上。
   *
   * 监听器是直接挂在 canvas 上的,不走 React —— 因为这块 canvas 是解码器
   * 自己 new 出来的,不归 React 管。挂在 canvas 上也正好保证坐标量的是
   * 画面本身,而不是外层盒子。
   *
   * canvas 塞进 canvasHost(一个 display: contents 的空盒子),量的还是
   * stage 这个带 padding 的外层盒子。两件事分开是为了 replaceChildren 只
   * 清掉画面,不把 React 渲染的提示条一起清掉。
   */
  useEffect(() => {
    const host = stage.current
    const mount = canvasHost.current
    if (host === null || mount === null || screen === null) return

    const canvas = screen.canvas
    if (!(canvas instanceof HTMLCanvasElement)) {
      setFailure({
        message: "画面渲染器没有给出 canvas",
        hint: "换个浏览器试试。",
      })
      return
    }

    // max-h/max-w 只当兜底(第一帧还没量出容器尺寸之前别让它溢出),
    // 真正的大小由下面的 fit() 定。
    canvas.className = "max-h-full max-w-full touch-none select-none outline-none"
    canvas.tabIndex = 0
    mount.replaceChildren(canvas)
    setScreenSize(screen.size)

    /**
     * 按画面比例缩放到刚好放进 stage —— 这里"缩"和"放"都要做。
     *
     * 之前只给 canvas 挂了 max-h-full/max-w-full,那条路只会**往下**缩:
     * 容器比画面小的时候贴合得很好,可容器一旦变大(进全屏、把窗口拉大),
     * canvas 就停在解码器给的原始像素数上不动了,多出来的空间全是黑的 ——
     * 屏幕越大反而显得画面越小。所以尺寸自己算:短边贴合,宽高比不变。
     *
     * 尺寸写在 canvas 自己的 CSS 上(而不是外面再套一层),点击坐标才能继续
     * 直接按 canvas 的矩形换算(见下面的 pointOf)。
     */
    const fit = () => {
      const { width, height } = screen.size
      if (width === 0 || height === 0) return
      const style = window.getComputedStyle(host)
      const padding = (value: string) => Number.parseFloat(value) || 0
      // clientWidth/Height 含 padding,减掉之后才是画面真正能用的地方。
      const boxWidth =
        host.clientWidth - padding(style.paddingLeft) - padding(style.paddingRight)
      const boxHeight =
        host.clientHeight - padding(style.paddingTop) - padding(style.paddingBottom)
      if (boxWidth <= 0 || boxHeight <= 0) return
      const scale = Math.min(boxWidth / width, boxHeight / height)
      canvas.style.width = `${width * scale}px`
      canvas.style.height = `${height * scale}px`
    }

    fit()
    // 容器大小变了就重算:窗口缩放、进出浏览器全屏、命令面板收放都会走到这。
    // 画面尺寸不反过来影响 stage(它是 flex 撑出来的固定大小),不会转圈。
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    // 旋转、改分辨率之后宽高比也换了,得跟着重量一次。
    const unsubscribe = screen.onSizeChanged((size) => {
      setScreenSize(size)
      fit()
    })

    const pointOf = (
      event: PointerEvent | WheelEvent
    ): { x: number; y: number } | null => {
      const rect = canvas.getBoundingClientRect()
      const size = screen.size
      if (rect.width === 0 || rect.height === 0 || size.width === 0) return null
      return {
        x: ((event.clientX - rect.left) / rect.width) * size.width,
        y: ((event.clientY - rect.top) / rect.height) * size.height,
      }
    }

    // 鼠标的三个键各干各的:
    //   左键(以及触摸、触控笔) -> 点按和拖动,就是手指按在设备上;
    //   右键                     -> 安卓的"返回"(黑屏时点亮屏幕),和官方
    //                               scrcpy 桌面版的默认映射一致;
    //   别的键                   -> 先不管。
    // 浏览器自己的右键菜单在下面被挡掉了。
    let rightDown = false
    // 真的发过"按下"的那些指针。抬起得配对着发,而且不能让右键、中键漏到
    // 下面那条触摸的路里 —— 不然设备会收到一次没头没脑的抬手,正按着的
    // 手指也会被这一下点断。
    const touching = new Set<number>()

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault()
      canvas.focus({ preventScroll: true })
      if (event.button === 2) {
        if (!rightDown) {
          rightDown = true
          screen.backOrScreenOn(true)
        }
        return
      }
      if (event.button !== 0) return
      canvas.setPointerCapture(event.pointerId)
      touching.add(event.pointerId)
      const point = pointOf(event)
      if (point !== null) screen.touch("down", point.x, point.y)
    }
    const onPointerMove = (event: PointerEvent) => {
      // 只有按着的时候才算拖动。用"抓没抓住这个指针"判断,触摸和鼠标都成立。
      if (!canvas.hasPointerCapture(event.pointerId)) return
      const point = pointOf(event)
      if (point !== null) screen.touch("move", point.x, point.y)
    }
    const finishPointer = (event: PointerEvent) => {
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
      // 右键松手 -> 设备的返回键跟着松手。pointercancel 的 button 是 -1,
      // 所以这里还得看一眼上面那面旗子:漏掉这一下,设备那边的返回键就会
      // 一直按着不放。
      if (event.button === 2 || (rightDown && event.type === "pointercancel")) {
        rightDown = false
        screen.backOrScreenOn(false)
      }
      // 剩下的只处理左键(触摸)那一次的收尾。
      if (event.type === "pointerup" && event.button !== 0) return
      if (!touching.delete(event.pointerId)) return
      const point = pointOf(event)
      if (point !== null) screen.touch("up", point.x, point.y)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = pointOf(event)
      if (point !== null) {
        screen.scroll(point.x, point.y, event.deltaX, event.deltaY)
      }
    }
    const onContextMenu = (event: MouseEvent) => {
      // 右键在这个画面上是"返回"(见 onPointerDown),别让它再弹出浏览器
      // 自己那个菜单。页面别处(比如命令输入框)的右键菜单照常。
      event.preventDefault()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // 只剩画面时 Esc 是"退出",不该再当成 Android 的返回键 —— 交给上面
      // 那个捕获阶段的监听器。
      if (event.key === "Escape" && screenOnly) return
      // Ctrl/Cmd+V:本机剪贴板 -> 设备。走 scrcpy 的剪贴板协议,不逐字注入,
      // 长文本、换行、中文都能过。
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault()
        void pasteToDevice()
        return
      }
      const keyCode = KEY_CODES[event.key]
      if (keyCode !== undefined) {
        event.preventDefault()
        screen.key(keyCode, AndroidKeyEventAction.Down)
        return
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        // 能打出字符的键直接当文字注入。中文输入法的候选词走不了这条
        // (浏览器不给),所以这里只覆盖直接敲键盘的情况。
        event.preventDefault()
        screen.text(event.key)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      const keyCode = KEY_CODES[event.key]
      if (keyCode !== undefined) {
        event.preventDefault()
        screen.key(keyCode, AndroidKeyEventAction.Up)
      }
    }

    canvas.addEventListener("pointerdown", onPointerDown)
    canvas.addEventListener("pointermove", onPointerMove)
    canvas.addEventListener("pointerup", finishPointer)
    canvas.addEventListener("pointercancel", finishPointer)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.addEventListener("contextmenu", onContextMenu)
    canvas.addEventListener("keydown", onKeyDown)
    canvas.addEventListener("keyup", onKeyUp)

    // 键盘直接能用,不用先点一下画面。
    canvas.focus({ preventScroll: true })

    return () => {
      unsubscribe()
      observer.disconnect()
      canvas.removeEventListener("pointerdown", onPointerDown)
      canvas.removeEventListener("pointermove", onPointerMove)
      canvas.removeEventListener("pointerup", finishPointer)
      canvas.removeEventListener("pointercancel", finishPointer)
      canvas.removeEventListener("wheel", onWheel)
      canvas.removeEventListener("contextmenu", onContextMenu)
      canvas.removeEventListener("keydown", onKeyDown)
      canvas.removeEventListener("keyup", onKeyUp)
      canvas.remove()
    }
    // screenOnly 切换时这个 effect 必须重跑:换布局会把 stage 这个 div 整个
    // 换掉(canvas 是它的子节点,跟着一起没了),得重新挂一次。
  }, [screen, screenOnly, pasteToDevice])

  useEffect(() => {
    const onFullscreenChange = () => {
      // 浏览器全屏被退出(Esc、或者系统抢走了)时,别把画面留在一个没有
      // 任何控件的空白页上。
      if (document.fullscreenElement === null) setScreenOnly(false)
    }
    document.addEventListener("fullscreenchange", onFullscreenChange)
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange)
  }, [])

  /**
   * 只剩画面时怎么退出。
   *
   * 主路径是 Esc:浏览器在全屏状态下自己吃掉 Esc 并退出全屏,`fullscreenchange`
   * 那边跟着收起这个模式。但**全屏请求有可能被拒**(比如嵌在 iframe 里),
   * 那时 Esc 会送到页面上来 —— 这里兜住,不然用户就被关在一个没有出口的
   * 画面里了。用捕获阶段,抢在画面那个 keydown 之前处理。
   */
  useEffect(() => {
    if (!screenOnly) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (document.fullscreenElement === null) {
        event.preventDefault()
        setScreenOnly(false)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [screenOnly])

  // 提示自己消失,不用用户去关。
  useEffect(() => {
    if (hint === null) return
    const timer = window.setTimeout(() => setHint(null), 5000)
    return () => window.clearTimeout(timer)
  }, [hint])

  // 有输出就跟着滚到底,不然跑个长命令得自己往下拖。
  useEffect(() => {
    const element = outputRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [output])

  /** 进"只剩画面":浏览器全屏 + 隐藏所有控件。全屏被拒也没关系,画面照样铺满。 */
  const enterScreenOnly = () => {
    setScreenOnly(true)
    void root.current?.requestFullscreen().catch(() => {})
  }

  const rotate = () => {
    if (screen === null) return
    screen.rotate()
    // 转不转是前台应用说了算:锁竖屏的界面不会动。先说清楚,免得用户
    // 以为按钮坏了。
    setHint("已请设备旋转。锁竖屏的应用(桌面)不会跟着转,相册这类会。")
  }

  const run = async () => {
    if (adb === null || running || command.trim() === "") return
    setRunning(true)
    setOutput("")
    try {
      // 整条当字符串传:adbd 收到之后本来就是交给 shell 跑的,管线和 && 都
      // 能用。**别自己套 `sh -c`** —— 那会被 adbd 再套一层,引号被剥两遍,
      // `sh -c 'echo a; echo b'` 会变成先跑 `echo`(没有参数)再跑 `echo b`。
      const process = await adb.subprocess.noneProtocol.spawn(command)
      const reader = process.output.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        const text = decoder.decode(value, { stream: true })
        setOutput((current) => current + text)
      }
    } catch (error) {
      const { message } = toFailure(error)
      setOutput((current) => `${current}\n[出错] ${message}`)
    } finally {
      setRunning(false)
    }
  }

  const status =
    failure !== null
      ? { tone: "danger" as const, label: "连不上" }
      : screenGone
        ? { tone: "warn" as const, label: "画面断了" }
        : screen === null
          ? { tone: "neutral" as const, label: "连接中" }
          : { tone: "ok" as const, label: "画面正常" }

  /**
   * 画面顶上那一条:连接中、断了、直接失败都在这儿说。
   *
   * 位置固定在画面最上面、水平居中,而且**全屏(只剩画面)时也照摆** ——
   * 以前那一版全屏时不显示任何东西,画面一断,屏幕上就剩一片黑,连重连的
   * 按钮都找不到,只能靠双击(还容易误触)退出来。
   *
   * 内容就这一份,两种模式各摆一次(见 noticeLayer)。
   */
  const notice =
    failure !== null ? (
      <div className="pointer-events-auto animate-rise max-w-md rounded-xl border border-danger/30 bg-panel/95 px-4 py-3 text-center text-sm shadow-lg backdrop-blur">
        <p className="text-danger">{failure.message}</p>
        {failure.hint !== "" && (
          <p className="mt-1.5 text-xs text-muted">{failure.hint}</p>
        )}
        <Button
          size="sm"
          className="mt-3"
          onClick={() => setAttempt((n) => n + 1)}
        >
          <Refresh className="size-3.5" />
          重来一次
        </Button>
      </div>
    ) : screenGone ? (
      <div className="pointer-events-auto animate-rise flex max-w-md flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-line bg-panel/95 px-4 py-2.5 text-sm text-muted shadow-lg backdrop-blur">
        <span>画面断了。</span>
        <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
          <Refresh className="size-3.5" />
          重来一次
        </Button>
      </div>
    ) : screen === null ? (
      <div className="animate-rise flex flex-col items-center gap-2 rounded-xl bg-black/50 px-4 py-3 text-center text-sm text-muted">
        <Spinner className="size-5 animate-spin" />
        <span>正在准备画面……</span>
        <span className="text-[11px] text-faint">
          设备那边要起一个编码器,第一次会慢几秒
        </span>
      </div>
    ) : null

  // 把提示钉在画面区域的最上面。这一层自己不拦鼠标(pointer-events-none),
  // 不然会挡住画面上的操作;里面的卡片自己把事件收回来(pointer-events-auto),
  // 重连按钮才点得到。
  const noticeLayer =
    notice === null ? null : (
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
        {notice}
      </div>
    )

  // 只剩画面:整页就一个 canvas,别的什么都不留 —— 屏幕上多少像素,全给画面。
  // 全屏里一个按钮都不挂,退出就靠 Esc(浏览器自己会退出全屏,fullscreenchange
  // 那边跟着收;全屏请求被拒的场合由上面那个捕获阶段的监听器兜住)。
  if (screenOnly) {
    return (
      <div
        ref={root}
        className="fixed inset-0 z-50 flex bg-black"
        // 在这个界面上右键是安卓的"返回",别让浏览器自己的菜单盖上来。
        onContextMenu={(event) => event.preventDefault()}
      >
        <div
          ref={stage}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
        >
          {/* contents:这层盒子自己不参与排版,canvas 在里面就还是 stage 的
              直接子元素,能继续被居中、按比例缩放。 */}
          <div ref={canvasHost} className="contents" />
          {/* 断了、失败、连接中,全屏时也照样说 —— 不然画面一断,屏幕上就
              只剩一片黑,连重连的按钮都找不到。 */}
          {noticeLayer}
        </div>
        {hint !== null && (
          <p className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
            <span className="rounded-full bg-black/70 px-3.5 py-1.5 text-xs text-white/90 backdrop-blur">
              {hint}
            </span>
          </p>
        )}
      </div>
    )
  }

  return (
    <div ref={root} className="fixed inset-0 z-40 flex flex-col bg-app">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-app/95 px-3 backdrop-blur-xl sm:px-4">
        <Button size="sm" onClick={onClose}>
          <ArrowLeft className="size-4" />
          管理台
        </Button>

        <h1
          className="min-w-0 truncate font-mono text-sm font-semibold"
          title={container.name}
        >
          {container.name}
        </h1>
        <Badge tone={status.tone} pulse={status.tone === "ok"}>
          {status.label}
        </Badge>

        <div className="ml-auto hidden items-center gap-3 font-mono text-[11px] text-faint md:flex">
          {adb?.banner.model !== undefined && <span>{adb.banner.model}</span>}
          {facts !== null && <span>Android {facts.android}</span>}
          {screenSize !== null && (
            <span>
              {screenSize.width}×{screenSize.height}
            </span>
          )}
        </div>

        <IconButton
          onClick={() => setShowShell((current) => !current)}
          title={showShell ? "收起命令" : "展开命令"}
          aria-label={showShell ? "收起命令" : "展开命令"}
          className="ml-auto text-fg md:ml-3"
        >
          <Terminal className="size-4" />
        </IconButton>
        <IconButton
          onClick={enterScreenOnly}
          title="只剩画面(全屏)"
          aria-label="只剩画面(全屏)"
          className="text-fg"
        >
          <Expand className="size-4" />
        </IconButton>
      </header>

      <div
        ref={stage}
        // 画面区域:撑满剩下的地方,黑底居中。canvas 自己按比例缩放,
        // 这里不许出现滚动条,也不许裁。
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2 sm:p-4"
        // 右键落在画面上(包括画面外那圈黑边)是安卓的"返回",不是浏览器菜单。
        onContextMenu={(event) => event.preventDefault()}
      >
        {/* 见上面 screenOnly 那份的同名节点:canvas 有自己的一块地方,
            不会被提示条挤掉,也不会反过来把它清掉。 */}
        <div ref={canvasHost} className="contents" />
        {noticeLayer}
      </div>

      {deviceClipboard !== null && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-3 py-2">
          <span className="shrink-0 text-[11px] text-faint">设备剪贴板</span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted"
            title={deviceClipboard}
          >
            {preview(deviceClipboard)}
          </span>
          <Button
            size="sm"
            onClick={() => {
              void copyText(deviceClipboard).then((copied) => {
                if (copied) {
                  setDeviceClipboard(null)
                  setHint("已复制到本机剪贴板。")
                } else {
                  setHint("浏览器还是不让写,换成 HTTPS 打开这个页面再试。")
                }
              })
            }}
          >
            <Copy className="size-3.5" />
            复制到本机
          </Button>
          <IconButton
            onClick={() => setDeviceClipboard(null)}
            title="收起"
            aria-label="收起"
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      )}

      {hint !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 flex justify-center px-4">
          <p className="max-w-xl rounded-xl border border-line bg-panel/95 px-4 py-2 text-center text-xs leading-relaxed text-muted shadow-lg">
            {hint}
          </p>
        </div>
      )}

      {showShell && (
        <section className="shrink-0 border-t border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <Terminal className="size-3.5 text-faint" />
            <span className="text-[11px] text-faint">
              命令(在容器里的 Android 上执行)
            </span>
            <IconButton
              onClick={() => setShowShell(false)}
              title="收起命令"
              aria-label="收起命令"
              className="ml-auto"
            >
              <X className="size-3.5" />
            </IconButton>
          </div>
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="font-mono text-brand">$</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void run()
              }}
              placeholder="getprop ro.build.version.release"
              spellCheck={false}
              className={cx(controlClass, "flex-1 font-mono")}
            />
            <Button
              tone="primary"
              disabled={running || command.trim() === ""}
              onClick={() => void run()}
            >
              {running && <Spinner className="size-4 animate-spin" />}
              运行
            </Button>
          </div>
          {output !== "" && (
            <pre
              ref={outputRef}
              className="scroll-slim max-h-52 overflow-auto border-t border-line bg-panel-2 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
            >
              {output}
            </pre>
          )}
        </section>
      )}

      <footer className="flex h-16 shrink-0 items-center justify-center gap-2 overflow-x-auto border-t border-line bg-app/95 px-3 backdrop-blur-xl">
        <ConsoleKey
          icon={<ArrowLeft className="size-5" />}
          label="返回"
          disabled={screen === null}
          onClick={() => screen?.tapKey(AndroidBackKey)}
        />
        <ConsoleKey
          icon={<Home className="size-5" />}
          label="Home"
          disabled={screen === null}
          onClick={() => screen?.tapKey(AndroidHomeKey)}
        />
        <ConsoleKey
          icon={<Apps className="size-5" />}
          label="最近"
          disabled={screen === null}
          onClick={() => screen?.tapKey(AndroidKeyCode.AndroidAppSwitch)}
        />
        <span className="mx-1 h-8 w-px shrink-0 bg-line" />
        <ConsoleKey
          icon={<Volume className="size-5" />}
          label="音量−"
          disabled={screen === null}
          onClick={() => screen?.tapKey(AndroidKeyCode.VolumeDown)}
        />
        <ConsoleKey
          icon={<Volume className="size-5" />}
          label="音量+"
          disabled={screen === null}
          onClick={() => screen?.tapKey(AndroidKeyCode.VolumeUp)}
        />
        <ConsoleKey
          icon={<Power className="size-5" />}
          label="电源"
          disabled={screen === null}
          onClick={() => screen?.tapKey(AndroidKeyCode.Power)}
        />
        <span className="mx-1 h-8 w-px shrink-0 bg-line" />
        <ConsoleKey
          icon={
            muted ? (
              <VolumeOff className="size-5" />
            ) : (
              <Volume className="size-5" />
            )
          }
          label={muted ? "已静音" : "声音"}
          title={
            screen?.hasSound === true
              ? muted
                ? "打开声音"
                : "静音"
              : "这台上没有声音(浏览器不支持,或者设备那边起不来)"
          }
          disabled={screen?.hasSound !== true}
          onClick={() => setMuted((current) => !current)}
        />
        <ConsoleKey
          icon={<Rotate className="size-5" />}
          label="旋转"
          title="请设备转 90°(当前界面锁竖屏的话不会跟着转)"
          disabled={screen === null}
          onClick={rotate}
        />
        <ConsoleKey
          icon={<Copy className="size-5" />}
          label="粘贴"
          title="把本机剪贴板粘贴到设备(也可以直接按 Ctrl/Cmd+V)"
          disabled={screen === null}
          onClick={() => void pasteToDevice()}
        />
        <ConsoleKey
          icon={<Screen className="size-5" />}
          label="只剩画面"
          disabled={false}
          onClick={enterScreenOnly}
        />
      </footer>
    </div>
  )
}

/** 底下那排整键。带一个图标一行小字,和手机上的导航栏是一个意思。 */
const ConsoleKey = ({
  icon,
  label,
  title,
  disabled,
  onClick,
}: {
  readonly icon: React.ReactNode
  readonly label: string
  readonly title?: string
  readonly disabled: boolean
  readonly onClick: () => void
}) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className="inline-flex h-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-2.5 text-[10px] text-muted transition hover:bg-panel-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
  >
    {icon}
    {label}
  </button>
)
