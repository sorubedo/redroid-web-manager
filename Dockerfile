# syntax=docker/dockerfile:1

FROM node:24-trixie AS build

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
RUN pnpm build


FROM node:24-trixie-slim AS deps

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --prod


FROM node:24-trixie-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/sorubedo/redroid-web-manager"

ENV NODE_ENV=production \
    REDROID_WEB_STATIC_DIR=/app/web/dist

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
# scrcpy 的服务端 jar:构建时下好、验过摘要,和镜像一起发出去 ——
# 运行期不用出网,也不会出现"第一次看屏幕才去下 jar"这种事。
COPY --from=build /app/assets ./assets

USER root
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REDROID_WEB_PORT??3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
