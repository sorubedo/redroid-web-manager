# redroid-web-manager

管理本机 Docker 里 redroid 容器的网页界面:看/拉/删镜像、建容器、起停删
容器、把 tar 层叠成新镜像。后端是一个 Fastify 服务,前端是 React + Tailwind
的静态页面。

## 快速开始

开发时(前端 vite 带热更新,后端 tsx 带自动重启,两个一起起):

```bash
pnpm install
pnpm dev            # 前端 http://localhost:5173,后端 http://127.0.0.1:3000
```

编译后运行(一个进程,一个端口,页面和 `/api` 同源):

```bash
pnpm build          # tsc -> dist/,vite build -> web/dist/
pnpm start          # = node dist/index.js
```

## 启动参数与环境变量

优先级一律是 **命令行 > 环境变量 > 默认值**。环境变量都带 `REDROID_WEB_`
前缀(`HOST`、`PORT` 这种名字太常见,裸着用迟早撞车)。

| 命令行 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--host <地址>` | `REDROID_WEB_HOST` | `127.0.0.1` | HTTP 服务监听的地址,只收 IP 字面量(或 `localhost`) |
| `-p, --port <端口>` | `REDROID_WEB_PORT` | `3000` | HTTP 服务监听的端口 |
| `--static-dir <目录>` | `REDROID_WEB_STATIC_DIR` | 仓库里的 `web/dist` | 一并托管前端页面 |
| `--no-web` | `REDROID_WEB_STATIC=off` | 关 | 只提供 `/api`,不管前端 |
| `--docker-host <地址>` | `REDROID_WEB_DOCKER_HOST` | `unix:///var/run/docker.sock` | 要连的 Docker;`DOCKER_HOST` 也认,但带前缀的优先 |
|  | `REDROID_WEB_ADB_HOST` | 跟着容器的绑定地址走 | 去哪台机器连容器的 adb 端口。后端自己跑在容器里时要指到宿主,例如 `host.docker.internal` |

`--host` 默认是 `127.0.0.1`:这个服务没有登录验证,却能操作 Docker(等于
宿主机的 root),所以默认不让别人连。写成 `0.0.0.0` 只有在"容器里跑、宿主上
只发布到 loopback"这种场景下才是对的,启动时会打印提醒。

前端的 vite 开发代理读 `REDROID_WEB_API`(默认 `http://127.0.0.1:3000`),
后端端口挪过之后用得上:

```bash
pnpm dev:server --port 3100 & REDROID_WEB_API=http://127.0.0.1:3100 pnpm dev:web
```

## 部署

### 单进程(推荐,最省事)

`pnpm build` 之后直接 `pnpm start`,后端会把 `web/dist` 当静态目录一起托管:
页面、脚本、`/api` 都在同一个端口上,不用配反向代理,也没有跨域问题。没匹配
到的路径会回落到 `index.html`(`/api` 底下不会,拼错的接口照常 404)。

```bash
pnpm build
REDROID_WEB_PORT=3000 pnpm start
```

长期跑请交给 systemd 或容器:进程自己不做守护,也不写日志文件。

### 前后端分开

想用 caddy/nginx 托管前端、或者前端走 CDN 的话,后端加 `--no-web`,然后按
下面这样把 `/api` 反代过去(前端是静态文件,注意 SPA 回落):

```caddy
redroid.example.com {
  handle /api/* {
    reverse_proxy 127.0.0.1:3000
  }
  handle {
    root * /srv/redroid-web/dist
    try_files {path} /index.html
    file_server
  }
}
```

这个组合下**一定要给 caddy 那一层加认证**(basic auth、mTLS、或者放在
Tailscale / Cloudflare Access 后面)。程序本身没有登录,谁能打开页面谁就能
操作你的 Docker。

### 用 Docker 跑它自己

桥接网络(常用):

```bash
docker run -d --name redroid-web \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e REDROID_WEB_HOST=0.0.0.0 \
  -p 127.0.0.1:3000:3000 \
  redroid-web-manager
```

两个关键点:

* 容器里**必须**监听 `0.0.0.0`。端口发布是 DNAT 到容器 eth0 的地址,绑在
  容器 loopback 上的服务,宿主连不进去 —— 那样只会得到 connection refused。
* 发布端口时写 `127.0.0.1:3000:3000`,别写 `-p 3000:3000`。后者绑宿主所有
  网卡,等于把这个能操作 Docker 的服务直接挂到公网上。

host 网络模式(不需要发布端口):

```bash
docker run -d --name redroid-web \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  redroid-web-manager
```

这时容器里的监听地址就是宿主机的监听地址,保持默认的 `127.0.0.1` 即可。
注意 host 模式下容器里 `DOCKER_HOST` 别再指向本机 —— 它和宿主共用网络栈。

## 拉官方镜像

「镜像」页下半部分是 Docker Hub 上 `redroid/redroid` 的官方 `-latest` 标签
(`<Android 版本>[_64only]-latest`),点「拉取」就由本机的 Docker daemon 去拉,
进度(整条 + 每层 blob)边拉边显示,拉完直接就能拿它创建容器。已经在的标签
会标成「已在本机」。

这个列表是后端去 `hub.docker.com` 拿的,所以要**能出网**。拿不到只是这一块
显示不出来,本机已有的镜像照常用;也可以用页面上的 `docker pull` 提示手动拉。
拉取本身走 Docker daemon,和你手动敲 `docker pull` 是同一条路。

## 关于 adb 端口

建容器时 adb 端口默认只绑宿主的 `127.0.0.1`(要监听哪个地址在创建页面里选)。
`0.0.0.0` 那个选项会让同网络的机器都能连 —— **adb 没有鉴权,连上就是 Android
里的 root**,只在确实要远程连、而且前面还有别的防护时才用。

端口绑定是创建容器时定下来的,老容器(`0.0.0.0`)改不了,得重建。页面上会把
对全网开放的容器标出来,想自己查:

```bash
docker inspect -f '{{json .HostConfig.PortBindings}}' <容器名>
```

留空端口时,程序会从 5555 往上找第一个没被别的容器声明的端口(它问的是
Docker daemon,所以不管它自己在哪跑,拿到的都是宿主上的占用情况;宿主机上
非 Docker 进程占的端口它看不到,那种情况会在启动容器时报错)。

## 在浏览器里看画面(scrcpy)

容器卡片上的「看屏幕」会在浏览器里开一个 scrcpy 会话:画面、触摸、滚轮、
键盘都直接对着容器里的 Android。**不需要装 adb,也不需要 platform-tools**
—— 后端自己用 Tango(ADB 协议的 TypeScript 实现)直连容器的 adbd。

链路是这样的(全程只有你那个 HTTP 端口):

```
浏览器(跑 Tango 和 scrcpy 客户端)
  │  WebSocket,一条对应设备上一条 ADB socket
  ▼
后端(只搬字节,不解释 ADB)
  │  TCP 到容器的 5555
  ▼
容器里的 adbd
```

后端和容器之间只有一条 ADB 连接,所有人共用(设备上的 adbd 同时只认一个
客户端)。最后一个用的人走了之后 30 秒放开,免得你手动 `adb connect` 时挤不
进去。后端自己跑在容器里的话,用 `REDROID_WEB_ADB_HOST` 告诉它宿主在哪。

scrcpy 的服务端是一个七百多 KB 的 jar,后端第一次用的时候从 GitHub 下一份
(校验 sha256)缓存起来,前端每次会话把它推到容器里。所以**第一次用需要能
出网**;下不下来时页面上会说明。

版本是写死的,而且**前后端两处必须一致**:`src/scrcpy-server.ts`(下哪个
jar)和 `web/src/adb/scrcpy.ts`(按哪个版本的参数表发命令)。现在跟的是
**scrcpy 4.1**。能驱动哪个版本取决于 Tango:4.1 需要
`@yume-chan/*` 的 `3.0.0-beta.*`(正式版只到 scrcpy 3.3.3),所以这个
项目现在用的是 beta —— 它的公开 API 官方说不保证稳定,升级时前后端要一起动。

画面要求浏览器支持 WebCodecs(Chrome / Edge 这类)。解不了的时候面板会直接
说,不会给你一块黑屏。

## 目录结构

```
src/        后端:HTTP 接口、Docker 操作、redroid 参数表
web/src/    前端:React + Tailwind,亮暗两套主题
web/dist/   pnpm build 的产物,由后端托管
```
