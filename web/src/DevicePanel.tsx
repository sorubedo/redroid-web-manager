import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react"
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
import { Play, Screen, Spinner, Terminal, X } from "./icons"
import { Button, controlClass, cx, FailureBox } from "./ui"

// 一台容器的设备视图:scrcpy 的画面 + 设备信息 + 一条命令输入框。
//
// ADB 全程走浏览器(前端是一个完整的 Tango Adb 实例),后端只把字节从
// WebSocket 搬到容器。这意味着**没有鉴权这件事在这里被放大**:能打开这个
// 面板的人,就等于拿到了容器里 Android 的屏幕和 shell。

interface DevicePanelProps {
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

const Fact = ({
  label,
  value,
}: {
  readonly label: string
  readonly value: string | null
}) => (
  <div className="min-w-0">
    <dt className="text-[11px] text-faint">{label}</dt>
    <dd className="mt-0.5 truncate font-mono text-[13px]" title={value ?? ""}>
      {value ?? <span className="text-faint">…</span>}
    </dd>
  </div>
)

// 键盘上哪些键该翻译成 Android 的键码。能打出字符的键不走这里 —— 那些
// 直接当文字注入(见 onKeyDown)。这张表只收那些没有字符的键。
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

export const DevicePanel = ({ container, onClose }: DevicePanelProps) => {
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

  const canvasHost = useRef<HTMLDivElement>(null)

  const [command, setCommand] = useState("")
  const [output, setOutput] = useState("")
  const [running, setRunning] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)

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
        // 留下一条没人关的连接,而 adbd 同时只认一个客户端。
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

  // 画布是解码器自己创建的,这里只是把它挂进页面。尺寸也跟着视频变。
  useEffect(() => {
    const host = canvasHost.current
    if (host === null || screen === null) return

    const canvas = screen.canvas
    if (!(canvas instanceof HTMLCanvasElement)) {
      setFailure({
        message: "画面渲染器没有给出 canvas",
        hint: "换个浏览器试试。",
      })
      return
    }

    canvas.className = "block h-auto w-full"
    host.replaceChildren(canvas)
    setScreenSize(screen.size)
    const unsubscribe = screen.onSizeChanged(setScreenSize)

    return () => {
      unsubscribe()
      canvas.remove()
    }
  }, [screen])

  // 有输出就跟着滚到底,不然跑个长命令得自己往下拖。
  useEffect(() => {
    const element = outputRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [output])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // 屏幕上的像素 -> 视频里的坐标。scrcpy 要的是视频坐标系。
  const toVideo = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (screen === null) return null
      const bounds = event.currentTarget.getBoundingClientRect()
      const size = screen.size
      if (bounds.width === 0 || bounds.height === 0) return null
      return {
        x: ((event.clientX - bounds.left) / bounds.width) * size.width,
        y: ((event.clientY - bounds.top) / bounds.height) * size.height,
      }
    },
    [screen]
  )

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

  const busy = failure === null && screen === null && !screenGone

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <section
        aria-modal="true"
        role="dialog"
        aria-label={`${container.name} 的设备视图`}
        onClick={(event) => event.stopPropagation()}
        className="animate-rise flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Screen className="size-4 shrink-0 text-brand" />
          <h2
            className="min-w-0 flex-1 truncate font-mono text-sm font-semibold"
            title={container.name}
          >
            {container.name}
          </h2>
          <Button size="sm" onClick={onClose} aria-label="关闭">
            <X className="size-4" />
          </Button>
        </header>

        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-line bg-black/95 p-3">
            {failure !== null ? (
              <FailureBox
                failure={failure}
                onRetry={() => setAttempt((n) => n + 1)}
              />
            ) : screenGone ? (
              <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted">
                <span>画面断了。</span>
                <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  <Play className="size-3.5" />
                  重来一次
                </Button>
              </div>
            ) : (
              <>
                <div
                  ref={canvasHost}
                  // 焦点放在这里,键盘事件才收得到;触摸坐标也靠它算。
                  tabIndex={0}
                  role="application"
                  aria-label="设备画面"
                  className="relative mx-auto max-h-[60vh] w-fit max-w-full cursor-default overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    event.currentTarget.focus()
                    const point = toVideo(event)
                    if (point !== null) screen?.touch("down", point.x, point.y)
                  }}
                  onPointerMove={(event) => {
                    // 只有按着的时候才算拖动;鼠标划过不算。
                    if (event.buttons === 0) return
                    const point = toVideo(event)
                    if (point !== null) screen?.touch("move", point.x, point.y)
                  }}
                  onPointerUp={(event) => {
                    const point = toVideo(event)
                    if (point !== null) screen?.touch("up", point.x, point.y)
                  }}
                  onWheel={(event: ReactWheelEvent<HTMLDivElement>) => {
                    if (screen === null) return
                    const bounds = event.currentTarget.getBoundingClientRect()
                    const size = screen.size
                    const x =
                      ((event.clientX - bounds.left) / bounds.width) * size.width
                    const y =
                      ((event.clientY - bounds.top) / bounds.height) *
                      size.height
                    screen.scroll(x, y, event.deltaX, event.deltaY)
                  }}
                  onKeyDown={(event) => {
                    const keyCode = KEY_CODES[event.key]
                    if (keyCode !== undefined) {
                      event.preventDefault()
                      screen?.key(keyCode, AndroidKeyEventAction.Down)
                    } else if (
                      event.key.length === 1 &&
                      !event.ctrlKey &&
                      !event.metaKey
                    ) {
                      // 能打出字符的键直接当文字注入。中文输入法的候选词走不了
                      // 这条(浏览器不给),所以这里只覆盖直接敲键盘的情况。
                      event.preventDefault()
                      screen?.text(event.key)
                    }
                  }}
                  onKeyUp={(event) => {
                    const keyCode = KEY_CODES[event.key]
                    if (keyCode !== undefined) {
                      event.preventDefault()
                      screen?.key(keyCode, AndroidKeyEventAction.Up)
                    }
                  }}
                >
                  {screen === null && (
                    <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-10 py-12 text-sm text-muted">
                      <Spinner className="size-4 animate-spin" />
                      正在准备画面……
                    </div>
                  )}
                </div>

                {screen !== null && (
                  <div className="mx-auto mt-2.5 flex w-fit items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => screen.tapKey(AndroidBackKey)}
                    >
                      返回
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => screen.tapKey(AndroidHomeKey)}
                    >
                      Home
                    </Button>
                    <span className="ml-1 font-mono text-[11px] text-faint">
                      {screenSize === null
                        ? ""
                        : `${screenSize.width}×${screenSize.height}`}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="p-4">
            {adb !== null && (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <Fact label="型号" value={adb.banner.model ?? null} />
                  <Fact
                    label="Android 版本"
                    value={facts === null ? null : facts.android}
                  />
                  <Fact label="架构" value={facts === null ? null : facts.abi} />
                  <Fact label="adb 序列号" value={adb.serial} />
                </dl>

                <div className="mt-5 border-t border-line pt-4">
                  <div className="flex items-center gap-2 text-[11px] text-faint">
                    <Terminal className="size-3.5" />
                    命令(在容器里的 Android 上执行)
                  </div>
                  <div className="mt-2 flex items-center gap-2">
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
                      className="scroll-slim mt-3 max-h-64 overflow-auto rounded-xl border border-line bg-panel-2 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
                    >
                      {output}
                    </pre>
                  )}
                </div>
              </>
            )}

            {adb === null && failure === null && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="size-4 animate-spin" />
                正在连容器的 adb……
              </div>
            )}

            {busy && adb !== null && (
              <p className="mt-3 text-[11px] text-faint">
                画面第一次出来要几秒(设备那边要起一个编码器)。
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
