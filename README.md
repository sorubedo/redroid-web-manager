# redroid-web-manager

> ⚠ **别对公网开放。** 这个程序没有鉴权，默认只听 `127.0.0.1` 。

## 部署

两种跑法各一份 compose,区别只在网络:

|  | [compose.net-host.yml](compose.net-host.yml) | [compose.bridge.yml](compose.bridge.yml) |
| --- | --- | --- |
| 网络模式 | `network_mode: host`,不发布端口 | bridge + 端口发布 |
| 容器里监听 | `REDROID_WEB_HOST=127.0.0.1` | `REDROID_WEB_HOST=0.0.0.0` |
| 宿主上谁能连 | 只有本机 | 只有本机(`ports` 钉死在 `127.0.0.1`) |
| 换端口 | 改 `REDROID_WEB_PORT` | 改 `ports` 左边那个数字 |
| 连容器的 adb | 不用配 | 配 `REDROID_WEB_ADB_HOST=host.docker.internal` |
| 适合 | 单机自用 | 不想用 host 网络 |

## 配置项

命令行 > 环境变量 > 默认值,环境变量都带 `REDROID_WEB_` 前缀。

| 命令行 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--host <地址>` | `REDROID_WEB_HOST` | `127.0.0.1` | 监听地址(host 模式下就是宿主上的地址) |
| `-p, --port <端口>` | `REDROID_WEB_PORT` | `3000` | 监听端口 |
| `--static-dir <目录>` | `REDROID_WEB_STATIC_DIR` | `web/dist` | 一并托管前端页面 |
| `--no-web` | `REDROID_WEB_STATIC=off` | 关 | 只提供 `/api` |
| `--docker-host <地址>` | `REDROID_WEB_DOCKER_HOST` | `unix:///var/run/docker.sock` | 要连的 Docker |
|  | `REDROID_WEB_ADB_HOST` | 跟着容器的绑定地址走 | 去哪台机器连容器的 adb 端口 |
