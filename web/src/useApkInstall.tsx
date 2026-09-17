import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type { Adb } from "@yume-chan/adb"
import { ApiFailure, formatSize } from "./api"

/**
 * 「装 APK」这件小事的界面部分:挑文件、报进度、把设备的拒绝翻译成人话。
 *
 * 真正搬文件、跑 pm 的部分在 adb/apk.ts 里,而且要等用户真挑了文件才动态
 * 加载 —— 那一套(Tango 的 ADB 客户端)是整站最大的一块代码,不装 APK 的
 * 人不该为它多下一份。
 *
 * 两个地方用它:容器卡片(手上没有连接,现连一条,装完就关)和看屏幕那个
 * 页面(手上就是连着设备的 adb,直接用)。
 */

export interface ApkFailure {
  readonly message: string
  readonly hint: string
}

export interface ApkInstallOptions {
  /** 装到哪台容器(名字或 id)。手上没连接时用它去连。 */
  readonly container: string
  /** 已经连好的 adb,比如看屏幕页面上那条。给了就直接用,也不负责关。 */
  readonly adb?: Adb | null
  /** 装好了说一声 —— 卡片那边要闪一条提示。 */
  readonly onDone?: (message: string) => void
}

export interface ApkInstallController {
  /** 点一下就是"打开文件选择框"。 */
  pick(): void
  /** 藏起来的文件输入框。得挂在界面上,不然脚本点不开它。 */
  readonly input: ReactNode
  readonly busy: boolean
  /** 忙的时候那一行字:传输进度、正在安装。其余时候是 null。 */
  readonly label: string | null
  /** 传输进度 0~1;不在传文件那段是 null。 */
  readonly progress: number | null
  /** 上一次没装成。找个地方显示它,或者用 clear() 收掉。 */
  readonly failure: ApkFailure | null
  /** 传到一半不要了。 */
  cancel(): void
  clear(): void
}

type State =
  | { readonly kind: "upload"; readonly sent: number; readonly total: number }
  | { readonly kind: "install" }
  | { readonly kind: "failed"; readonly failure: ApkFailure }

export const useApkInstall = (
  options: ApkInstallOptions
): ApkInstallController => {
  const { container, adb = null, onDone } = options
  const fileInput = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<State | null>(null)
  /** 正在跑的那一次安装。用户按了取消就拿它把传输叫停。 */
  const running = useRef<AbortController | null>(null)

  // 卸载之后异步回来的进度不该再往 React 里塞。StrictMode 会把 effect 跑两遍
  // (挂上、拆掉、再挂上),所以这里不是一次性的旗子。
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const start = useCallback(
    async (file: File) => {
      const controller = new AbortController()
      running.current = controller
      setState({ kind: "upload", sent: 0, total: file.size })

      // 大文件传起来要分钟级,进度得动。但每写一块都 setState 会把主线程
      // 铺满,而那些渲染没人看得出来 —— 变一个百分点再更新一次就够了。
      let reported = -1
      let created: Adb | null = null

      try {
        const { installApk } = await import("./adb/apk")

        let connection = adb
        if (connection === null) {
          // 卡片上没有现成的连接:现连一条,装完关掉。后端到 adbd 的那条是
          // 所有会话共用的长连接,关掉浏览器这条不影响别人。
          const { connectContainer } = await import("./adb/connect")
          created = await connectContainer(container)
          connection = created
        }

        await installApk(connection, file, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!alive.current) return
            if (progress.phase === "install") {
              setState({ kind: "install" })
              return
            }
            const percent =
              progress.total === 0
                ? 100
                : Math.floor((progress.sent / progress.total) * 100)
            if (percent === reported) return
            reported = percent
            setState({
              kind: "upload",
              sent: progress.sent,
              total: progress.total,
            })
          },
        })

        if (!alive.current) return
        setState(null)
        onDone?.(`已安装 ${file.name}`)
      } catch (error) {
        if (!alive.current) return
        // 自己按了取消不算失败,什么都不说才是对的。
        setState(
          controller.signal.aborted
            ? null
            : { kind: "failed", failure: describe(error) }
        )
      } finally {
        // 借来的连接(看屏幕那条)不能关,现连的这条要关。
        void created?.close()
        if (running.current === controller) running.current = null
      }
    },
    [adb, container, onDone]
  )

  const input = (
    <input
      ref={fileInput}
      type="file"
      accept=".apk,application/vnd.android.package-archive"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0] ?? null
        // 清掉,不然连着挑同一个文件不会再触发 change。
        event.target.value = ""
        if (file !== null) void start(file)
      }}
    />
  )

  const uploading = state?.kind === "upload" ? state : null
  const label =
    uploading !== null
      ? `正在传输 ${percentOf(uploading.sent, uploading.total)}% · ${formatSize(
          uploading.sent
        )} / ${formatSize(uploading.total)}`
      : state?.kind === "install"
        ? "设备正在安装…"
        : null

  return {
    pick: useCallback(() => fileInput.current?.click(), []),
    input,
    busy: state?.kind === "upload" || state?.kind === "install",
    label,
    progress:
      uploading === null ? null : percentOf(uploading.sent, uploading.total) / 100,
    failure: state?.kind === "failed" ? state.failure : null,
    cancel: useCallback(() => {
      // abort() 会让传输在下一块之前停下,那条 shell 也跟着断(见 apk.ts)。
      running.current?.abort()
    }, []),
    clear: useCallback(() => setState(null), []),
  }
}

const percentOf = (sent: number, total: number): number =>
  total === 0 ? 100 : Math.min(100, Math.floor((sent / total) * 100))

/** 什么错都能翻译成"一句解释 + 一句怎么办"给 FailureBox 用。 */
const describe = (error: unknown): ApkFailure => {
  if (error instanceof ApiFailure) {
    return { message: error.message, hint: error.hint }
  }
  if (error instanceof Error) {
    const hint = (error as { readonly hint?: unknown }).hint
    return {
      message: error.message === "" ? "装不上,设备没给原因" : error.message,
      hint: typeof hint === "string" ? hint : "",
    }
  }
  return { message: String(error), hint: "" }
}
