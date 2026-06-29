# syntax=docker/dockerfile:1.7
#
# Obfuscated eval-server image. Ships only the minified+obfuscated SvelteKit
# adapter-node bundle — no TypeScript sources, no source maps, no Drizzle
# schema files. Gated to /api/external/* via EVAL_SERVER_MODE.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app

# Install everything (build deps + runtime deps)
COPY package.json bun.lock ./
RUN bun install --no-progress

# Bring in sources and produce the adapter-node bundle
COPY . .
RUN bun run build

# Strip source maps that vite/svelte may have emitted
RUN find build -name '*.map' -delete 2>/dev/null || true

# Obfuscate the server bundle. Conservative settings — string-array transforms
# break a few SvelteKit chunks, so we stick with identifier/control-flow only.
RUN bun add -d javascript-obfuscator@4.1.1
RUN node -e "                                                              \
const fs = require('fs'); const path = require('path');                    \
const obf = require('javascript-obfuscator');                              \
const walk = d => fs.readdirSync(d, {withFileTypes:true}).flatMap(e => {   \
  const p = path.join(d, e.name);                                          \
  return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);  \
});                                                                        \
const opts = {                                                             \
  compact: true,                                                           \
  controlFlowFlattening: false,                                            \
  identifierNamesGenerator: 'mangled-shuffled',                            \
  renameGlobals: false,                                                    \
  selfDefending: false,                                                    \
  simplify: true,                                                          \
  splitStrings: false,                                                     \
  stringArray: false,                                                      \
  transformObjectKeys: false,                                              \
  unicodeEscapeSequence: false,                                            \
};                                                                         \
for (const f of walk('build')) {                                           \
  const src = fs.readFileSync(f, 'utf8');                                  \
  if (src.length > 2_000_000) continue;                                    \
  try { fs.writeFileSync(f, obf.obfuscate(src, opts).getObfuscatedCode()); }\
  catch (e) { console.warn('skip', f, e.message); }                        \
}                                                                          \
"

# ── Production deps ───────────────────────────────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --no-progress --production

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV EVAL_SERVER_MODE=1

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/build        ./build
COPY --from=build /app/package.json ./package.json

# Drop any leftover dev artifacts and verify no .ts / .map remain
RUN find . -name '*.ts' -not -path './node_modules/*' -delete \
 && find . -name '*.map' -not -path './node_modules/*' -delete \
 && find . -name 'tsconfig*.json' -not -path './node_modules/*' -delete \
 && find . -name 'svelte.config*' -not -path './node_modules/*' -delete

EXPOSE 3000
CMD ["node", "build/index.js"]
