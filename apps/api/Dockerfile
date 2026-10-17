# Аудит п.37: node:22-alpine, frozen-lockfile, образ работает от пользователя node.
FROM node:22-alpine AS base
RUN apk add --no-cache openssl
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY .npmrc .npmrc

# Воркспейс копируем целиком (все package.json) — иначе --frozen-lockfile
# не может сверить lockfile с проектами.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app ./
COPY . .
RUN pnpm --filter @marketplace/shared build
RUN pnpm --filter @marketplace/db build
RUN pnpm --filter @marketplace/api build

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
# Аудит п.33: в контейнере слушаем все интерфейсы (публиция порта в
# docker-compose привязана к 127.0.0.1 хоста).
ENV HOST=0.0.0.0
WORKDIR /app/apps/api
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build --chown=node:node /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/db/dist /app/packages/db/dist
COPY --from=build --chown=node:node /app/node_modules/.prisma /app/node_modules/.prisma
RUN mkdir -p /home/node && chown -R node:node /home/node
USER node
EXPOSE 4000
CMD ["node", "dist/src/server.js"]
