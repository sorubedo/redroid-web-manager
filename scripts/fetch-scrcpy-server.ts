import {
  SCRCPY_VERSION,
  ScrcpyServerUnavailable,
  fetchScrcpyServer,
} from "../src/scrcpy-server.js"

/**
 * 构建前把 scrcpy 的服务端 jar 下到 assets/(package.json 的 build 和 dev
 * 都会先跑它)。下不下来或者内容不对就退出码非 0:让构建在这儿失败,总好过
 * 镜像发出去以后有人点「看屏幕」才发现。
 */
const main = async (): Promise<void> => {
  const { path, downloaded } = await fetchScrcpyServer()
  console.log(
    `${downloaded ? "下好了" : "已经在了"} scrcpy ${SCRCPY_VERSION} 的服务端:${path}`
  )
}

main().catch((error: unknown) => {
  console.error(
    `错误:${error instanceof Error ? error.message : String(error)}`
  )
  if (error instanceof ScrcpyServerUnavailable) {
    console.error(`提示:${error.hint}`)
  }
  process.exitCode = 1
})
