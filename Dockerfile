# syntax=docker/dockerfile:1.7

# ── Build stage: install everything, build the SvelteKit Node bundle ──────────
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ── Deps stage: production-only node_modules ──────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Runtime stage: minimal Node image running the adapter-node bundle ─────────
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/build        ./build
COPY package.json ./

EXPOSE 3000
CMD ["node", "build/index.js"]
