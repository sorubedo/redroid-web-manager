import type { Adb } from "@yume-chan/adb"
import { concatUint8Arrays } from "@yume-chan/stream-extra"

/**
 * 往容器里装一个 APK。
 *
 * 走的就是 `adb install` 现在的做法:让设备那边的 `pm install -S <字节数>`
 * 从 stdin 读整份 APK,浏览器这头把文件流直接灌进去。设备上不落临时文件,
 * 也就没有"传到一半残留在设备上"这种要收拾的局面;页面一关,那条 shell 断
 * 了,设备自己会把没装完的东西扔了。
 *
 * (老版 adb 是先 push 到 /data/local/tmp 再 `pm install <路径>`,能跑但多
 * 一次完整的写入和一次删除。)
 *
 * 放在浏览器这边而不是后端,还有一个实际的好处:「看屏幕」那个页面手上
 * 本来就有连着设备的 adb,装 APK 直接接着用,不用为它另开一条通道。
 */

/** 装到哪一步了。upload 阶段的 sent / total 是字节。 */
export interface ApkInstallProgress {
  readonly phase: "upload" | "install"
  readonly sent: number
  readonly total: number
}

export interface ApkInstallOptions {
  /** 每写一块报一次(一块 64 KiB 上下),调用方自己决定要不要限流。 */
  readonly onProgress?: (progress: ApkInstallProgress) => void
  /** 中途不要了(用户按了取消、页面被关掉)。 */
  readonly signal?: AbortSignal
}

/**
 * 没装上。
 *
 * message 是给用户看的一句话,hint 是接下来该怎么办 —— 认得出来的原因码
 * 说人话,认不出来的就把设备原话端上去。
 */
export class ApkInstallFailed extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = "ApkInstallFailed"
    this.hint = hint
  }
}

export const installApk = async (
  adb: Adb,
  file: File,
  options: ApkInstallOptions = {}
): Promise<void> => {
  if (file.size === 0) {
    throw new ApkInstallFailed(
      `这个文件是空的:${file.name}`,
      "重新挑一份 APK。"
    )
  }

  // -r 覆盖安装(应用数据留着),-t 允许 testOnly 的包 —— 自己构建的调试版
  // 常带这个标记,在这台开发用的安卓上没必要卡它。-S 后面那个字节数是设备
  // 要读多少:两边对不上它会直接把这次安装判失败,所以必须给 file.size。
  const process = await adb.subprocess.noneProtocol.spawn(
    ["pm", "install", "-r", "-t", "-S", String(file.size)],
    options.signal
  )
  // 带了 signal 的时候,Tango 会把这条 socket 的关闭也接进一个 promise
  // (exited),取消时那个 promise 是以取消理由拒绝的。这里不关心它,但必须
  // 接住 —— 不接就是一条没人处理的拒绝。
  void process.exited.catch(() => {})

  // 一边灌一边收:pm 弄明白装不上时会直接退出,它的话就在输出里。两个方向
  // 必须同时进行 —— 只顾着写、不管输出的话,设备那边的缓冲满了就卡住了。
  const output: Uint8Array[] = []
  let readFailure: unknown = null
  const reading = (async () => {
    for await (const chunk of process.output) output.push(chunk)
  })().catch((error: unknown) => {
    readFailure = error
  })

  const writer = process.stdin.getWriter()
  const reader = file.stream().getReader()
  let writeFailure: unknown = null
  let sent = 0

  try {
    for (;;) {
      if (options.signal?.aborted === true) break
      const { done, value } = await reader.read()
      if (done) break
      await writer.write(value)
      sent += value.byteLength
      options.onProgress?.({ phase: "upload", sent, total: file.size })
    }
    await writer.close()
  } catch (error) {
    // 设备提前收摊(它一看就知道装不上)的时候写不进去,这不是异常情况:
    // 原因在输出里,下面照常拿出来报给用户。
    writeFailure = error
  } finally {
    await reader.cancel().catch(() => {})
  }

  // 信号一断,上面那条 shell 就被关了,设备会把没装完的东西扔掉。取消就是
  // 取消,不该被当成"设备没回话"报给用户。
  options.signal?.throwIfAborted()

  // 文件灌完了,剩下的时间都花在设备的包管理器上。
  options.onProgress?.({ phase: "install", sent: file.size, total: file.size })
  await reading
  await Promise.resolve(process.kill()).catch(() => {})

  // 取消要盖过"设备没回话":信号一断,Tango 就把那条 shell 关了,设备的
  // 输出也就到这儿为止 —— 那不是链路出问题,是用户自己不要了。
  options.signal?.throwIfAborted()

  const text = new TextDecoder().decode(concatUint8Arrays(output)).trim()

  // 设备那边不管成没成都是正常退出,唯一的判据就是它这句话。"Success" 是
  // pm 打的那一行(它前面可能还有"Performing Streamed Install"之类),所以
  // 按行找,不是拿整段做前缀比对。
  if (/^\s*Success\s*$/m.test(text)) return
  if (text !== "") throw describe(text)

  // 设备一句话都没说:那就不是装不装得上的问题,而是这条链路的事。
  const failure = writeFailure ?? readFailure
  throw new ApkInstallFailed(
    failure instanceof Error && failure.message !== ""
      ? `和设备的连接断了:${failure.message}`
      : "设备没有回话,这次安装不知道成没成",
    "看一眼容器还在不在,然后重来一次。"
  )
}

/* ------------------------------------------------------------ 内部实现 */

/** 设备装不上时 pm 会在方括号里给一个原因码,比如 INSTALL_FAILED_UPDATE_INCOMPATIBLE。 */
const REASON = /INSTALL_[A-Z_]{3,}/

/** 设备那几行话 -> 给用户看的一句话 + 一句该怎么办。 */
const describe = (output: string): ApkInstallFailed => {
  const reason = REASON.exec(output)?.[0] ?? null
  const raw = summarize(output)

  switch (reason) {
    // 签名对不上。覆盖安装过不去,只能先把旧的卸掉。
    case "INSTALL_FAILED_UPDATE_INCOMPATIBLE":
    case "INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES":
      return new ApkInstallFailed(
        `设备上那份和这份签名不一样,覆盖不了(${reason})`,
        "先把它卸掉再装 —— 命令面板里 pm uninstall <包名>,或者在安卓里长按图标卸载。应用数据会跟着一起没。"
      )

    // 装的是比设备上更旧的版本。
    case "INSTALL_FAILED_VERSION_DOWNGRADE":
      return new ApkInstallFailed(
        `设备上那份的版本比这个高(${reason})`,
        "想退回旧版得先卸载原来的,再装这一份。"
      )

    // redroid 跑在 x86_64 上,而很多 APK 里只带了 arm 的原生库。
    case "INSTALL_FAILED_NO_MATCHING_ABIS":
      return new ApkInstallFailed(
        `这个 APK 里的原生库跟容器的 CPU 架构对不上(${reason})`,
        "redroid 一般是 x86_64:换一份带 x86_64 原生库的包,或者用带 arm 转译(libndk / libhoudini)的镜像。"
      )

    case "INSTALL_FAILED_INSUFFICIENT_STORAGE":
    case "INSTALL_FAILED_MEDIA_UNAVAILABLE":
      return new ApkInstallFailed(
        `设备上的空间不够了(${reason})`,
        "清一点安卓里的东西,或者换个 /data 大一些的容器。"
      )

    case "INSTALL_FAILED_OLDER_SDK":
      return new ApkInstallFailed(
        `这个 APK 要求的 Android 版本比容器里的新(${reason})`,
        "换一份要求低一些的包,或者用版本更新的 redroid 镜像。"
      )

    case "INSTALL_FAILED_USER_RESTRICTED":
      return new ApkInstallFailed(
        `设备这边不允许安装(${reason})`,
        "这台安卓里有设备管理 / 受限用户的限制,先在安卓里解掉。"
      )

    case "INSTALL_FAILED_INTERNAL_ERROR":
    case "INSTALL_FAILED_ABORTED":
      return new ApkInstallFailed(
        `设备那边自己出错了(${reason})`,
        "看一眼容器的日志(logcat)通常能看出是什么。"
      )
  }

  // 这一类是"读不了这个包":文件不完整,或者根本不是 APK。
  // 有的设备不给原因码,而是甩一句 "Failed to parse APK file"(redroid 的
  // Android 14 就是这样),所以两种都得认。
  if (
    (reason !== null && reason.startsWith("INSTALL_PARSE_FAILED")) ||
    /Failed to (parse|load|open) .{0,20}(APK|asset)/i.test(output)
  ) {
    return new ApkInstallFailed(
      `设备读不了这个包(${reason ?? "Failed to parse APK"})`,
      "多半是文件不完整,或者根本不是 APK(.apks / .xapk 那种分包的另说)。重新下一份再试。"
    )
  }

  return new ApkInstallFailed(
    raw === "" ? "设备没说为什么,反正没装上" : `设备装不上:${raw}`,
    "把设备原话拿去搜一搜;没头绪就看一眼容器的日志(logcat)。"
  )
}

/**
 * 从设备输出里挑一句能看的话。
 *
 * 失败时设备有时候会说人话,有时候直接把一整段 Java 堆栈端出来 —— 后者
 * 原样显示在界面上就没法看了,所以只取第一句像样的,并且掐个长度。
 */
const summarize = (output: string): string => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const line =
    lines.find((candidate) => /Failure|Error|Exception/.test(candidate)) ??
    lines[0] ??
    ""
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}
