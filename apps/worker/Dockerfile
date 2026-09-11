FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @marketplace/shared build
RUN pnpm --filter @marketplace/db build
RUN pnpm --filter @marketplace/worker build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/worker
COPY --from=build /app/apps/worker/dist ./dist
COPY --from=build /app/apps/worker/package.json ./
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/db/dist /app/packages/db/dist
COPY --from=build /app/packages/db/package.json /app/packages/db/package.json
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
CMD ["node", "dist/index.js"]
