# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY shared ./shared
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="价巡 PricePatrol" \
      org.opencontainers.image.description="多店铺淘宝/天猫 SKU 价格监控：Cookie 采集、折扣预警、多任务调度" \
      org.opencontainers.image.source="https://github.com/lwhx/PricePatrol" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
# The CLI comes from the locked local package, so its browser revision always
# matches npm ci, including after a deliberate package-lock.json update.
RUN npm ci --omit=dev \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force \
    && mkdir -p /app/data \
    && chown node:node /app/data
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node shared ./shared
COPY --from=build --chown=node:node /app/web/dist ./web/dist
USER node
VOLUME ["/app/data"]
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "server/src/main.ts"]
