import type { AdbCredentialStore, AdbPrivateKey } from "@yume-chan/adb"

/**
 * 握手时给 Tango 用的私钥来源。
 *
 * ADB 的认证是可选的:设备(adbd)如果配成 `ro.adb.secure=0`,握手过程里
 * 根本不会发 AUTH 包,那这个 store 一次都不会被读到。redroid 容器就是这个
 * 情况 —— 连上就是设备里的 root,没有"是否允许调试"那个弹窗。
 *
 * 之所以还是要提供,是因为 Tango 的接口要求传:万一哪个容器真的开了安全
 * 调试,它会拿这里的密钥去签名。**但这条路径基本走不通** —— 那种设备要靠
 * 屏幕上的弹窗确认,而容器里的 Android 没人点得到。真遇到了再说,不要为了
 * 它把密钥落盘。
 *
 * 所以:密钥只放内存,进程重启就没了。反正没人会用它。
 */
export class RedroidCredentialStore implements AdbCredentialStore {
  readonly #keys: Array<AdbPrivateKey> = []

  async generateKey(): Promise<AdbPrivateKey> {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        // ADB 认的就是 2048 位、指数 65537,和 Google 的实现保持一致 ——
        // 生成别的规格它验不过。
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: "SHA-1",
      },
      true,
      ["sign"]
    )

    // Tango 要的是 PKCS#8 的私钥字节,不是 WebCrypto 的句柄。
    const buffer = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey)
    )

    const key: AdbPrivateKey = { buffer, name: "redroid-web-manager" }
    this.#keys.push(key)
    return key
  }

  *iterateKeys(): Iterable<AdbPrivateKey> {
    yield* this.#keys
  }
}
