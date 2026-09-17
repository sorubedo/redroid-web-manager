import type { Adb } from "@yume-chan/adb"
import type { ScrcpyEncoder } from "@yume-chan/scrcpy"
import { useEffect, useState } from "react"
import { canDecodeVideoCodec, listVideoEncoders } from "./adb/scrcpy"
import {
  DEFAULT_VIDEO_SETTINGS,
  MAX_FPS_CHOICES,
  MAX_SIZE_CHOICES,
  VIDEO_BIT_RATE_CHOICES,
  codecLabel,
  sameVideoSettings,
  videoSettingsSummary,
  type VideoCodecName,
  type VideoSettingChoice,
  type VideoSettings,
} from "./adb/video-settings"
import { Check, Refresh, Spinner, X } from "./icons"
import { Button, IconButton, Section, cx } from "./ui"

/**
 * 看屏幕的视频设置。
 *
 * 四项都是服务端编码参数(scrcpy 的那个 server 进程),所以只能"改了重连":
 * 面板里先攒成一份草稿,点「应用并重连」才交出去(DeviceConsole 拿新的这份
 * 去重建会话)。取消就是什么都不发生 —— 画面一直在放,不用怕点错。
 */

interface Props {
  /** 现在正跑着的这套,用来显示"当前"和判断改没改 */
  readonly settings: VideoSettings
  /** 还不连上设备时是 null,这时只能看,不能列编码器 */
  readonly adb: Adb | null
  readonly onApply: (next: VideoSettings) => void
  readonly onClose: () => void
}

type Encoders =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly list: ReadonlyArray<ScrcpyEncoder> }
  | { readonly state: "failed"; readonly message: string }

export const VideoSettingsPanel = ({
  settings,
  adb,
  onApply,
  onClose,
}: Props) => {
  const [draft, setDraft] = useState<VideoSettings>(settings)
  const [encoders, setEncoders] = useState<Encoders>({ state: "loading" })
  /** 探测结果:这个浏览器解得开哪些格式(undefined = 还没问出来) */
  const [support, setSupport] = useState<
    Partial<Record<VideoCodecName, boolean>>
  >({})
  /** 点「重试」时加一,让上面那个 effect 重新问一次设备 */
  const [reload, setReload] = useState(0)

  const update = (patch: Partial<VideoSettings>) =>
    setDraft((current) => ({ ...current, ...patch }))

  // Esc 关面板、底下别跟着滚,和创建容器那个抽屉是一套做法。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  // 浏览器解得开哪些格式。这个和连没连上设备无关,进来就问一次。
  useEffect(() => {
    let cancelled = false
    const codecs: ReadonlyArray<VideoCodecName> = ["h264", "h265", "av1"]
    void Promise.all(
      codecs.map(
        async (codec) => [codec, await canDecodeVideoCodec(codec)] as const
      )
    ).then((entries) => {
      if (!cancelled) setSupport(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 设备上有哪些编码器。要推一份 jar 上去再跑一遍服务端,要一会儿。
  useEffect(() => {
    if (adb === null) {
      setEncoders({ state: "failed", message: "还没连上容器。" })
      return
    }
    let cancelled = false
    setEncoders({ state: "loading" })
    void listVideoEncoders(adb).then(
      (list) => {
        if (!cancelled) {
          setEncoders(
            list.length === 0
              ? { state: "failed", message: "设备没有报告任何编码器。" }
              : { state: "ready", list }
          )
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setEncoders({
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [adb, reload])

  const unchanged = sameVideoSettings(draft, settings)

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="关掉视频设置"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="视频设置"
        className="animate-slide-in relative flex h-full w-full max-w-md flex-col border-l border-line bg-app shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">视频设置</h2>
            <p
              className="mt-0.5 truncate font-mono text-[11px] text-faint"
              title={videoSettingsSummary(settings)}
            >
              {videoSettingsSummary(settings)}
            </p>
          </div>
          <IconButton onClick={onClose} aria-label="关闭">
            <X className="size-4" />
          </IconButton>
        </header>

        <div className="scroll-slim flex-1 space-y-7 overflow-y-auto px-5 py-5">
          <Section title="服务端编码器">
            <EncoderRow
              selected={draft.encoder === null}
              name="服务端自动选择"
              hint="H.264 · 服务端自己挑"
              onClick={() =>
                update({ encoder: null, codec: DEFAULT_VIDEO_SETTINGS.codec })
              }
            />

            {encoders.state === "loading" && (
              <p className="flex items-center gap-2 px-1 py-2 text-xs text-faint">
                <Spinner className="size-3.5 animate-spin" />
                正在读取编码器……
              </p>
            )}

            {encoders.state === "failed" && (
              <p className="flex flex-wrap items-center gap-2 px-1 py-2 text-xs text-faint">
                <span className="min-w-0 flex-1 truncate" title={encoders.message}>
                  读不到编码器:{encoders.message}
                </span>
                <Button size="sm" onClick={() => setReload((n) => n + 1)}>
                  <Refresh className="size-3.5" />
                  重试
                </Button>
              </p>
            )}

            {encoders.state === "ready" &&
              encoders.list.map((encoder) => {
                const codec = encoder.codec as VideoCodecName
                // 还没探到结果的先当能用,免得一进来满天灰。
                const playable = support[codec] !== false
                return (
                  <EncoderRow
                    key={encoder.name}
                    selected={draft.encoder === encoder.name}
                    name={encoder.name}
                    hint={
                      playable
                        ? codecLabel(codec)
                        : `${codecLabel(codec)} · 浏览器解不开`
                    }
                    disabled={!playable}
                    onClick={() => update({ encoder: encoder.name, codec })}
                  />
                )
              })}
          </Section>

          <Section title="服务端分辨率限制">
            <Chips
              value={draft.maxSize}
              choices={MAX_SIZE_CHOICES}
              onChange={(maxSize) => update({ maxSize })}
            />
          </Section>

          <Section title="服务端帧率限制">
            <Chips
              value={draft.maxFps}
              choices={MAX_FPS_CHOICES}
              onChange={(maxFps) => update({ maxFps })}
            />
          </Section>

          <Section title="码率">
            <Chips
              value={draft.videoBitRate}
              choices={VIDEO_BIT_RATE_CHOICES}
              onChange={(videoBitRate) => update({ videoBitRate })}
            />
          </Section>
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          <Button
            size="sm"
            onClick={() => setDraft(DEFAULT_VIDEO_SETTINGS)}
            title="回到服务端自动选编码器、原生分辨率、不限帧、24 Mbps"
          >
            恢复默认
          </Button>
          <Button
            tone="primary"
            size="sm"
            className="ml-auto"
            disabled={unchanged}
            onClick={() => onApply(draft)}
          >
            应用并重连
          </Button>
        </footer>
      </div>
    </div>
  )
}

/** 编码器列表里的一行。名字长,所以竖着排,不用小格子。 */
const EncoderRow = ({
  selected,
  name,
  hint,
  disabled = false,
  onClick,
}: {
  readonly selected: boolean
  readonly name: string
  readonly hint: string
  readonly disabled?: boolean
  readonly onClick: () => void
}) => (
  <button
    type="button"
    aria-pressed={selected}
    disabled={disabled}
    onClick={onClick}
    className={cx(
      "flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition",
      selected
        ? "border-brand/50 bg-brand-soft"
        : "border-line bg-panel hover:border-line-strong",
      disabled && "cursor-not-allowed opacity-45"
    )}
  >
    <span className="min-w-0 flex-1">
      <span
        className={cx(
          "block truncate font-mono text-[12px]",
          selected ? "text-brand" : "text-fg"
        )}
        title={name}
      >
        {name}
      </span>
      <span className="mt-0.5 block text-[11px] text-faint">{hint}</span>
    </span>
    {selected && <Check className="size-4 shrink-0 text-brand" />}
  </button>
)

/** 一排小格子:点一下就选中,值都是数字。 */
const Chips = ({
  value,
  choices,
  onChange,
}: {
  readonly value: number
  readonly choices: ReadonlyArray<VideoSettingChoice>
  readonly onChange: (next: number) => void
}) => (
  <div className="flex flex-wrap gap-2">
    {choices.map((choice) => (
      <button
        key={choice.value}
        type="button"
        aria-pressed={value === choice.value}
        onClick={() => onChange(choice.value)}
        title={choice.hint}
        className={cx(
          "rounded-lg border px-3 py-1.5 text-xs font-medium transition",
          value === choice.value
            ? "border-brand/50 bg-brand-soft text-brand"
            : "border-line bg-panel text-muted hover:border-line-strong hover:text-fg"
        )}
      >
        {choice.label}
      </button>
    ))}
  </div>
)
