# Build context: parent directory (..)
# Usage: cd .. && fly deploy --config summit/fly.toml --dockerfile summit/Dockerfile --remote-only

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable

# ── momo-db build ──────────────────────────────────────────────────────────────
FROM base AS momo-db-build
WORKDIR /app/momo-db
COPY momo-db/package.json momo-db/pnpm-lock.yaml momo-db/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY momo-db/tsconfig*.json ./
COPY momo-db/src ./src
RUN pnpm build

# ── summit deps (resolves @momo/db symlink via /app/momo-db) ──────────────────
FROM base AS summit-deps
COPY --from=momo-db-build /app/momo-db /app/momo-db
WORKDIR /app/summit
COPY summit/package.json summit/pnpm-lock.yaml summit/pnpm-workspace.yaml summit/.npmrc ./
RUN pnpm install --frozen-lockfile

# ── summit build ───────────────────────────────────────────────────────────────
FROM summit-deps AS summit-build
COPY summit/tsconfig*.json ./
COPY summit/src ./src
RUN pnpm build

# Production dependency closure is separate from the compiler/test toolchain.
FROM base AS production-deps
COPY --from=momo-db-build /app/momo-db/package.json /app/momo-db/package.json
COPY --from=momo-db-build /app/momo-db/dist /app/momo-db/dist
WORKDIR /app/summit
COPY summit/package.json summit/pnpm-lock.yaml summit/pnpm-workspace.yaml summit/.npmrc ./
RUN pnpm install --prod --frozen-lockfile

# ── runtime ────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# momo-db/dist は @momo/db symlink の解決先として必要
COPY --from=momo-db-build /app/momo-db/package.json /app/momo-db/package.json
COPY --from=momo-db-build /app/momo-db/dist /app/momo-db/dist

WORKDIR /app/summit
COPY --from=production-deps /app/summit/package.json ./
COPY --from=production-deps /app/summit/node_modules ./node_modules
COPY --from=summit-build /app/summit/dist ./dist

# The application needs no write access to its code or package tree.
USER node
CMD ["node", "dist/index.js"]
