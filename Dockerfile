FROM node:24-bookworm-slim AS build
ENV COREPACK_HOME=/tmp/corepack
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm build

FROM node:24-bookworm-slim AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

FROM runtime-base AS api
COPY --from=build /app/apps/api ./apps/api
CMD ["node", "apps/api/dist/server.js"]

FROM runtime-base AS worker
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/worker ./apps/worker
CMD ["node", "apps/worker/dist/worker.js"]

FROM runtime-base AS sandbox-runner
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/sandbox-runner ./apps/sandbox-runner
CMD ["node", "apps/sandbox-runner/dist/server.js"]

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
CMD ["node", "apps/web/server.js"]
