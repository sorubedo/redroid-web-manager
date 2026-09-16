import type { AdbCredentialManager } from "@yume-chan/adb"
import {
  AdbWebCryptoCredentialManager,
  TangoNodeStorage,
} from "@yume-chan/adb-credential-nodejs"

/**
 * 握手时用的私钥。
 *
 * redroid 容器一般配成 `ro.adb.secure=0`,握手过程里根本不会发 AUTH 包,
 * 所以这里多数时候一次都用不上。但真遇上开了安全调试的设备,能不能连上就
 * 全看这里 —— 所以用官方这套(而不是我先前那个只在内存里放一把钥匙的版本):
 *
 * - `TangoNodeStorage` 读写的是宿主上的 `~/.android/adbkey`,和 Google 的
 *   adb **是同一份**。也就是说你以前 authorize 过的设备,这里直接用得上;
 *   Tango 新生成的钥匙,宿主上敲 adb 也认。
 * - 还会读 `ADB_VENDOR_KEYS`,和 adb 的规矩一致。
 */
export const createCredentialManager = (): AdbCredentialManager =>
  new AdbWebCryptoCredentialManager(new TangoNodeStorage())
