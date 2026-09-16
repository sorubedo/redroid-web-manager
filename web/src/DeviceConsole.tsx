import { useEffect, useRef, useState } from "react"
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
  Expand,
  Home,
  Power,
  Rotate,
  Screen,
  Spinner,
  Terminal,
  Volume,
  X,
} from "./icons"
import { Badge, Button, controlClass, cx, IconButton } from "./ui"

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
  // 只剩画面:整页只留 canvas,别的都不显示。
  const [screenOnly, setScreenOnly] = useState(false)
  // 一句临时的提示(比如"设备没换方向")。
  const [hint, setHint] = useState<string | null>(null)

  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
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

  /**
   * 把解码器的画布挂进页面,顺便把输入接上。
   *
   * 监听器是直接挂在 canvas 上的,不走 React —— 因为这块 canvas 是解码器
   * 自己 new 出来的,不归 React 管。挂在 canvas 上也正好保证坐标量的是
   * 画面本身,而不是外层盒子。
   */
  useEffect(() => {
    const host = stage.current
    if (host === null || screen === null) return

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
    host.replaceChildren(canvas)
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

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault()
      canvas.setPointerCapture(event.pointerId)
      canvas.focus({ preventScroll: true })
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
      const point = pointOf(event)
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
      if (point !== null) screen.touch("up", point.x, point.y)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = pointOf(event)
      if (point !== null) {
        screen.scroll(point.x, point.y, event.deltaX, event.deltaY)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // 只剩画面时 Esc 是"退出",不该再当成 Android 的返回键 —— 交给上面
      // 那个捕获阶段的监听器。
      if (event.key === "Escape" && screenOnly) return
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
      canvas.removeEventListener("keydown", onKeyDown)
      canvas.removeEventListener("keyup", onKeyUp)
      canvas.remove()
    }
    // screenOnly 切换时这个 effect 必须重跑:换布局会把 stage 这个 div 整个
    // 换掉(canvas 是它的子节点,跟着一起没了),得重新挂一次。
  }, [screen, screenOnly])

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

  const exitScreenOnly = () => {
    setScreenOnly(false)
    if (document.fullscreenElement !== null) void document.exitFullscreen()
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

  // 只剩画面:整页就一个 canvas,别的什么都不留 —— 屏幕上多少像素,全给画面。
  // 退出按钮平时藏着,鼠标一动才出来,免得一直挡着。
  if (screenOnly) {
    return (
      <div
        ref={root}
        className="fixed inset-0 z-50 flex bg-black"
        // 触摸设备上没有 Esc 键,双击是唯一的出口。会顺带往设备发两下点按,
        // 但总比关在里面出不来强。
        onDoubleClick={exitScreenOnly}
      >
        <div
          ref={stage}
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
        />
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
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2 sm:p-4"
      >
        {failure !== null && (
          <div className="max-w-md text-center text-sm">
            <p className="text-danger">{failure.message}</p>
            {failure.hint !== "" && (
              <p className="mt-2 text-muted">{failure.hint}</p>
            )}
            <Button
              size="sm"
              className="mt-4"
              onClick={() => setAttempt((n) => n + 1)}
            >
              重来一次
            </Button>
          </div>
        )}

        {failure === null && screenGone && (
          <div className="flex flex-col items-center gap-3 text-sm text-muted">
            <span>画面断了。</span>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              重来一次
            </Button>
          </div>
        )}

        {failure === null && !screenGone && screen === null && (
          <div className="flex flex-col items-center gap-3 text-sm text-muted">
            <Spinner className="size-5 animate-spin" />
            <span>正在准备画面……</span>
            <span className="text-[11px] text-faint">
              设备那边要起一个编码器,第一次会慢几秒
            </span>
          </div>
        )}
      </div>

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
          icon={<Rotate className="size-5" />}
          label="旋转"
          title="请设备转 90°(当前界面锁竖屏的话不会跟着转)"
          disabled={screen === null}
          onClick={rotate}
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
