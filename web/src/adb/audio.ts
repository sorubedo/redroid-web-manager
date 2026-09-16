import {
  Float32PcmPlayer,
  Float32PlanerPcmPlayer,
  Int16PcmPlayer,
  type PcmPlayer,
} from "@yume-chan/pcm-player"
import { ScrcpyAudioCodec, type ScrcpyAudioStreamPacket } from "@yume-chan/scrcpy"
import {
  type ReadableStream,
  TransformStream,
  WritableStream,
} from "@yume-chan/stream-extra"

// 声音:音频包 -> WebCodecs 解码 -> pcm-player 播放。
//
// 官方库只把音频包从流里拆出来(yume-chan/ya-webadb#746),解码和播放得自己
// 接。这里是照着官方旧 demo 的做法:解码是两个 TransformStream,播放交给
// @yume-chan/pcm-player(内部是 AudioWorklet)。

const SAMPLE_RATE = 48_000
const CHANNELS = 2

const codecConfig = (codec: ScrcpyAudioCodec): AudioDecoderConfig => ({
  codec: codec.webCodecId,
  sampleRate: SAMPLE_RATE,
  numberOfChannels: CHANNELS,
})

export class ScrcpySound {
  /** 这个浏览器有没有 WebCodecs 的音频解码和 AudioWorklet。 */
  static get isSupported(): boolean {
    return (
      typeof AudioDecoder === "function" &&
      typeof AudioWorkletNode === "function"
    )
  }

  /** 这个编码有没有对应的播放器。flac 那种先不接。 */
  static canPlay(codec: ScrcpyAudioCodec): boolean {
    return (
      ScrcpySound.isSupported &&
      (codec === ScrcpyAudioCodec.Opus ||
        codec === ScrcpyAudioCodec.Aac ||
        codec === ScrcpyAudioCodec.Raw)
    )
  }

  readonly #codec: ScrcpyAudioCodec
  #player:
    | PcmPlayer<Float32Array>
    | PcmPlayer<Float32Array[]>
    | PcmPlayer<Int16Array>
    | null = null
  #muted = false
  #closed = false

  constructor(codec: ScrcpyAudioCodec) {
    this.#codec = codec
  }

  get muted(): boolean {
    return this.#muted
  }

  /** 静音只是不再往播放器里送,解码照旧 —— 取消静音马上就有声音。 */
  setMuted(muted: boolean): void {
    this.#muted = muted
  }

  async play(stream: ReadableStream<ScrcpyAudioStreamPacket>): Promise<void> {
    try {
      await this.#play(stream)
    } catch {
      // 声音断了就算了,该报的错视频那边会报。
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    void this.#player?.stop()
  }

  async #play(stream: ReadableStream<ScrcpyAudioStreamPacket>): Promise<void> {
    // 三种编码解出来的排布不一样(opus:交错 f32,aac:分平面 f32-planar,
    // raw:直接是 s16),所以配的播放器也不是同一个。
    if (this.#codec === ScrcpyAudioCodec.Opus) {
      const player = new Float32PcmPlayer(SAMPLE_RATE, CHANNELS)
      this.#player = player
      await player.start()
      await stream
        .pipeThrough(new OpusDecodeStream(codecConfig(this.#codec)))
        .pipeTo(this.#sink(player))
      return
    }

    if (this.#codec === ScrcpyAudioCodec.Aac) {
      const player = new Float32PlanerPcmPlayer(SAMPLE_RATE, CHANNELS)
      this.#player = player
      await player.start()
      await stream
        .pipeThrough(new AacDecodeStream(codecConfig(this.#codec)))
        .pipeTo(this.#sink(player))
      return
    }

    if (this.#codec === ScrcpyAudioCodec.Raw) {
      const player = new Int16PcmPlayer(SAMPLE_RATE, CHANNELS)
      this.#player = player
      await player.start()
      await stream.pipeTo(
        new WritableStream<ScrcpyAudioStreamPacket>({
          write: (packet) => {
            if (packet.type === "data" && packet.data.byteLength > 0) {
              this.#feed(player, int16Samples(packet.data))
            }
          },
        })
      )
      return
    }

    await discard(stream)
  }

  #sink<T>(player: PcmPlayer<T>): WritableStream<T> {
    return new WritableStream<T>({
      write: (samples) => this.#feed(player, samples),
    })
  }

  #feed<T>(player: PcmPlayer<T>, samples: T): void {
    if (this.#muted || this.#closed) return
    player.feed(samples)
  }
}

/** 把这条流读掉。不读的话设备那边的 socket 会堵住,视频跟着一起卡。 */
export const discard = async (
  stream: ReadableStream<ScrcpyAudioStreamPacket>
): Promise<void> => {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done } = await reader.read()
      if (done) return
    }
  } catch {
    // 断了就断了。
  } finally {
    reader.releaseLock()
  }
}

/** opus:解出来是交错的 f32,原样给 Float32PcmPlayer。 */
class OpusDecodeStream extends TransformStream<
  ScrcpyAudioStreamPacket,
  Float32Array
> {
  constructor(config: AudioDecoderConfig) {
    let decoder: AudioDecoder
    super({
      start(controller) {
        decoder = new AudioDecoder({
          error: (error) => controller.error(error),
          output: (output) => {
            try {
              controller.enqueue(interleavedSamples(output))
            } catch {
              // 已经收摊了。
            }
          },
        })
        decoder.configure(config)
      },
      transform(packet) {
        // configuration 包是 opus-in-ogg 的头,对裸流没用。
        if (packet.type !== "data" || packet.data.byteLength === 0) return
        decoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: 0,
            data: packet.data,
          })
        )
      },
      async flush() {
        await decoder.flush()
      },
    })
  }
}

/** aac:解出来是分平面的 f32-planar,给 Float32PlanerPcmPlayer。 */
class AacDecodeStream extends TransformStream<
  ScrcpyAudioStreamPacket,
  Float32Array[]
> {
  constructor(config: AudioDecoderConfig) {
    let decoder: AudioDecoder
    super({
      start(controller) {
        decoder = new AudioDecoder({
          error: (error) => controller.error(error),
          output: (output) => {
            const channels = Array.from(
              { length: output.numberOfChannels },
              (_, channel) => planarSamples(output, channel)
            )
            output.close()
            try {
              controller.enqueue(channels)
            } catch {
              // 已经收摊了。
            }
          },
        })
      },
      transform(packet) {
        if (packet.type === "configuration") {
          // 裸 aac 流必须给 description(AudioSpecificConfig),不然解不出来。
          decoder.configure({ ...config, description: packet.data })
          return
        }
        if (decoder.state !== "configured" || packet.data.byteLength === 0) {
          return
        }
        decoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: 0,
            data: packet.data,
          })
        )
      },
      async flush() {
        await decoder.flush()
      },
    })
  }
}

const interleavedSamples = (output: AudioData): Float32Array => {
  // 按它自己的排布拿。让 WebCodecs 顺手转格式在 Chrome 上偶尔会爆音。
  const options: AudioDataCopyToOptions = { format: "f32", planeIndex: 0 }
  const samples = new Float32Array(
    output.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT
  )
  output.copyTo(samples, options)
  output.close()
  return samples
}

const planarSamples = (output: AudioData, channel: number): Float32Array => {
  const options: AudioDataCopyToOptions = {
    format: "f32-planar",
    planeIndex: channel,
  }
  const samples = new Float32Array(
    output.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT
  )
  output.copyTo(samples, options)
  return samples
}

const int16Samples = (data: Uint8Array): Int16Array => {
  const samples = Math.floor(data.byteLength / Int16Array.BYTES_PER_ELEMENT)
  // 位置没对齐就不能直接盖在原来的 buffer 上。
  if (data.byteOffset % Int16Array.BYTES_PER_ELEMENT === 0) {
    return new Int16Array(data.buffer, data.byteOffset, samples)
  }
  return new Int16Array(data.slice().buffer, 0, samples)
}
