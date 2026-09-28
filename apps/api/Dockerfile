FROM node:20-alpine3.20 AS base
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY .npmrc .npmrc

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --no-frozen-lockfile --config.node-linker=hoisted --config.shamefully-hoist=true --config.auto-install-peers=true

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @marketplace/shared build
RUN pnpm --filter @marketplace/db build
RUN pnpm --filter @marketplace/api build

FROM node:20-alpine3.20 AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/db/dist /app/packages/db/dist
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
EXPOSE 4000
CMD ["node", "dist/src/server.js"]
