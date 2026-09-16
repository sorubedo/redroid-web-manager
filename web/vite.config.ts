import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// 开发时前端跑在 5173,后端跑在 3000,是两个不同的端口。
//
// 这里的 proxy 把 /api 开头的请求转给后端,所以前端代码里直接写
// fetch("/api/images") 就行 —— 不用管跨域,也不用把端口写死在前端里。
// 以后要改后端端口,这里是唯一跟着改的地方。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // 后端默认在 127.0.0.1:3000。用 --port / REDROID_WEB_PORT 挪过的话,
      // 这里用 REDROID_WEB_API 指过去,免得两个地方各写一份。
      "/api": {
        target: process.env["REDROID_WEB_API"] ?? "http://127.0.0.1:3000",
        // adb 转发的通道是 WebSocket,挂在 /api 底下。不开这个的话开发时
        // 只有普通请求能过去,握手会失败 —— 而且报错很难看出是这个原因。
        ws: true,
      },
    },
  },
})
