FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# node-pty needs python + build tools
RUN apk add --no-cache python3 make g++ bash

COPY package.json pnpm-lock.yaml ./

# Install all deps (including devDeps for build)
RUN pnpm install --frozen-lockfile

COPY . .

# Build renderer → out/renderer/public, server → out/server
RUN pnpm build:web

# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# bash + build tools for node-pty native compilation
RUN apk add --no-cache bash python3 make g++ && npm install -g node-gyp

COPY package.json pnpm-lock.yaml ./

# Production deps only — skip postinstall (electron-builder not in prod deps)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    NODEPTY=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty) && \
    cd "$NODEPTY" && node-gyp rebuild

COPY --from=builder /app/out/server ./out/server
COPY --from=builder /app/out/renderer/public/renderer ./out/public/renderer

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "out/server/index.mjs"]
