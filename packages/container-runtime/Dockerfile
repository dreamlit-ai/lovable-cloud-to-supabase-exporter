FROM node:22-alpine AS builder

RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dreamlit/lovable-cloud-to-supabase-exporter-container-runtime build

FROM postgres:17-alpine

RUN apk add --no-cache nodejs curl zip

WORKDIR /app

COPY --chmod=755 packages/container-runtime/run-clone.sh /run-clone.sh
COPY --from=builder /workspace/packages/container-runtime/dist/export-runner.js /app/export-runner.js

ENTRYPOINT ["node", "/app/export-runner.js"]
