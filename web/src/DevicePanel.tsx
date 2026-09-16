import { useEffect, useRef, useState } from "react"
import type { Adb } from "@yume-chan/adb"
import { connectContainer } from "./adb/connect"
import { ApiFailure, type RedroidContainer } from "./api"
import { Screen, Spinner, Terminal, X } from "./icons"
import { Button, controlClass, cx, FailureBox } from "./ui"

/**
 * 一台容器的设备视图。
 *
 * 现在里面是设备信息和一条命令输入框;下一步 scrcpy 的画面也放这里 ——
 * 通道是同一条(浏览器里的 Adb 实例),只是往上面再挂一个解码器和画布。
 *
 * ADB 全程走浏览器:后端只把字节从 WebSocket 搬到容器,所以"能做什么"完全
 * 由这里决定。这意味着**没有鉴权这件事在这里被放大**:能打开这个面板的人,
 * 就等于拿到了容器里 Android 的 shell。
 */

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

export const DevicePanel = ({ container, onClose }: DevicePanelProps) => {
  const [adb, setAdb] = useState<Adb | null>(null)
  const [facts, setFacts] = useState<Facts | null>(null)
  const [failure, setFailure] = useState<{
    message: string
    hint: string
  } | null>(null)

  const [command, setCommand] = useState("")
  const [output, setOutput] = useState("")
  const [running, setRunning] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let cancelled = false
    let opened: Adb | null = null

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

        const prop = async (key: string): Promise<string> =>
          (
            await connected.subprocess.noneProtocol.spawnWaitText([
              "getprop",
              key,
            ])
          ).trim()

        const [android, abi] = await Promise.all([
          prop("ro.build.version.release"),
          prop("ro.product.cpu.abi"),
        ])
        if (!cancelled) setFacts({ android, abi })
      } catch (error) {
        if (!cancelled) setFailure(toFailure(error))
      }
    })()

    return () => {
      cancelled = true
      opened?.close()
    }
  }, [container.name])

  // 画面上有输出就跟着滚到底,不然跑个长命令得自己往下拖。
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

  const model = adb?.banner.model ?? null

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

        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-4">
          {failure !== null && <FailureBox failure={failure} />}

          {failure === null && adb === null && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="size-4 animate-spin" />
              正在连容器的 adb……
            </div>
          )}

          {adb !== null && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <Fact label="型号" value={model} />
                <Fact
                  label="Android 版本"
                  value={facts === null ? null : facts.android}
                />
                <Fact
                  label="架构"
                  value={facts === null ? null : facts.abi}
                />
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
        </div>
      </section>
    </div>
  )
}
