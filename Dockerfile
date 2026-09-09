# syntax=docker/dockerfile:1.7

# ============================================================
# Stage 1: 构建静态站点
# ============================================================
FROM harbor.oalite.com/build/node:20.11.0 AS builder

WORKDIR /app

# 设置国内 npm 镜像源
RUN npm config set registry https://registry.npmmirror.com

# 先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./

# 替换 lockfile 中的源地址为国内镜像（npm ci 严格按 lockfile resolved URL 下载）
RUN sed -i 's|https://registry.npmjs.org|https://registry.npmmirror.com|g' package-lock.json

RUN npm ci --no-audit --no-fund

# 复制源码
COPY . .

# 构建时可通过 --build-arg 注入环境变量（提供默认值避免空字符串导致校验失败）
ARG DOCS_URL=https://help-center.qingflow.com
ARG DOCS_BASE_URL=/
ARG BUILD_COMMIT=""
ARG TYPESENSE_HOST=""
ARG TYPESENSE_COLLECTION=qingflow_help_docs
ARG TYPESENSE_SEARCH_API_KEY=""
ARG TYPESENSE_ENABLE_SEMANTIC=false
ARG OUTLINE_URL=https://outline.dev.oalite.com
ARG OUTLINE_COLLECTION=售后知识库

ENV DOCS_URL=${DOCS_URL} \
    DOCS_BASE_URL=${DOCS_BASE_URL} \
    BUILD_COMMIT=${BUILD_COMMIT} \
    DOCS_CONTENT_SOURCE=outline \
    OUTLINE_URL=${OUTLINE_URL} \
    OUTLINE_COLLECTION=${OUTLINE_COLLECTION} \
    TYPESENSE_HOST=${TYPESENSE_HOST} \
    TYPESENSE_COLLECTION=${TYPESENSE_COLLECTION} \
    TYPESENSE_SEARCH_API_KEY=${TYPESENSE_SEARCH_API_KEY} \
    TYPESENSE_ENABLE_SEMANTIC=${TYPESENSE_ENABLE_SEMANTIC}

# Outline token is available only to this build step and is not persisted in an image layer.
RUN --mount=type=secret,id=outline_api_token,required=true \
    OUTLINE_API_TOKEN="$(cat /run/secrets/outline_api_token)" npm run build

# ============================================================
# Stage 2: Nginx 提供静态服务
# ============================================================
FROM harbor.oalite.com/build/nginx:1.31.3 AS production

# 移除默认配置，使用自定义 nginx 配置
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 从构建阶段复制产物
COPY --from=builder /app/build /usr/share/nginx/html

EXPOSE 80

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
