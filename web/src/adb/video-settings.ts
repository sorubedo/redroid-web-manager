// 看屏幕时那几个"服务端侧"的视频参数:用哪个编码器、画面最大多少、帧率
// 上限、码率。
//
// 全是 scrcpy 服务端进程的参数 —— 它们决定服务端怎么编,不决定浏览器怎么
// 解。所以改一项就得把服务端重启一遍(见 DeviceConsole 里「应用」之后的
// 重连),不能像改音量那样当场生效。
//
// 这里的默认值就是以前写死在 scrcpy.ts 里的那一套:服务端自动挑编码器、
// 原生分辨率、不限帧、24 Mbps。从容器列表点进来看屏幕时用的就是这一套。

/** 服务端能用的视频编码格式。scrcpy 支持更多,这里只放我们敢用的。 */
export type VideoCodecName = "h264" | "h265" | "av1"

export interface VideoSettings {
  /** 编码格式。它跟着选中的编码器走,不是单独一项。 */
  readonly codec: VideoCodecName
  /**
   * 指定的服务端编码器名字(设备上报的,比如 c2.android.avc.encoder)。
   * null 表示不指定,让服务端自己挑 —— 这也是 scrcpy 原本的行为。
   */
  readonly encoder: string | null
  /** 画面最长边的上限(像素)。0 = 不限制,按设备原生分辨率编。 */
  readonly maxSize: number
  /** 帧率上限。0 = 不限制。 */
  readonly maxFps: number
  /** 码率,单位 bit/s(scrcpy 的参数就是按这个单位收的)。 */
  readonly videoBitRate: number
}

/**
 * 默认值 = 以前写死的那一套。
 *
 * 分辨率不限制是因为缩下去的画面对不上设备的真实分辨率:2560 的屏被压成
 * 1280,细节补不回来,界面上显示的那个尺寸也成了假的。这套东西基本只在本机
 * 127.0.0.1 用,省这点像素换不来什么。
 *
 * 码率跟着原生分辨率定:2560×1600 的像素数差不多是 1280 长边的四倍,再按
 * 以前那 4 Mbps 编会糊得比缩过的还难看。走回环,码率给高不吃亏。
 */
export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  codec: "h264",
  encoder: null,
  maxSize: 0,
  maxFps: 0,
  videoBitRate: 24_000_000,
}

/** 界面上那一格可点的选项。 */
export interface VideoSettingChoice {
  readonly value: number
  readonly label: string
  readonly hint?: string
}

/**
 * 分辨率限制给的是"最长边",和 scrcpy 的 --max-size 一个意思(它不是宽,
 * 也不是高,是两者里大的那个)。竖屏 1280×720 和横屏 720×1280 是同一档。
 */
export const MAX_SIZE_CHOICES: ReadonlyArray<VideoSettingChoice> = [
  { value: 0, label: "不限制", hint: "原生分辨率" },
  { value: 1600, label: "1600", hint: "长边 ≤ 1600" },
  { value: 1280, label: "1280", hint: "长边 ≤ 1280" },
  { value: 1024, label: "1024", hint: "长边 ≤ 1024" },
  { value: 720, label: "720", hint: "长边 ≤ 720" },
]

/** 帧率上限。设备本来就上不去 60 的,选了也只是个上限,不会凭空变流畅。 */
export const MAX_FPS_CHOICES: ReadonlyArray<VideoSettingChoice> = [
  { value: 0, label: "不限制" },
  { value: 60, label: "60" },
  { value: 30, label: "30" },
  { value: 15, label: "15" },
]

/** 码率。走本机回环,给高不吃亏;要串流到别的机器上时再往下压。 */
export const VIDEO_BIT_RATE_CHOICES: ReadonlyArray<VideoSettingChoice> = [
  { value: 24_000_000, label: "24 Mbps" },
  { value: 16_000_000, label: "16 Mbps" },
  { value: 12_000_000, label: "12 Mbps" },
  { value: 8_000_000, label: "8 Mbps" },
  { value: 4_000_000, label: "4 Mbps" },
]

const CODEC_LABELS: Record<VideoCodecName, string> = {
  h264: "H.264",
  h265: "H.265",
  av1: "AV1",
}

export const codecLabel = (codec: VideoCodecName): string => CODEC_LABELS[codec]

/** 传进来的字符串是不是我们能用的编码格式。 */
export const isVideoCodecName = (value: string): value is VideoCodecName =>
  value === "h264" || value === "h265" || value === "av1"

export const sameVideoSettings = (
  a: VideoSettings,
  b: VideoSettings
): boolean =>
  a.codec === b.codec &&
  a.encoder === b.encoder &&
  a.maxSize === b.maxSize &&
  a.maxFps === b.maxFps &&
  a.videoBitRate === b.videoBitRate

/** 当前配置的一句话摘要,按钮的悬停提示和设置里都用它。 */
export const videoSettingsSummary = (settings: VideoSettings): string => {
  const parts = [
    settings.encoder === null ? "编码器自动" : settings.encoder,
    settings.maxSize === 0 ? "原生分辨率" : `≤${settings.maxSize}`,
    settings.maxFps === 0 ? "不限帧" : `${settings.maxFps} fps`,
    settings.videoBitRate % 1_000_000 === 0
      ? `${settings.videoBitRate / 1_000_000} Mbps`
      : `${Math.round(settings.videoBitRate / 1000)} kbps`,
  ]
  return parts.join(" · ")
}
