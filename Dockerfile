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

# Runtime deps: bash (node-pty), git (terraform source cloning), curl/unzip (tool installs)
RUN apk add --no-cache bash git git-lfs curl unzip jq

# ── Install GitHub CLI (gh) for GitHub device OAuth flow ──────────────────────
RUN GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | tr -d 'v') && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tar.gz && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh && \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"

# ── tfenv (Terraform version manager) ────────────────────────────────────────
RUN git clone --depth=1 https://github.com/tfutils/tfenv.git /opt/tfenv && \
    ln -s /opt/tfenv/bin/tfenv /usr/local/bin/tfenv && \
    ln -s /opt/tfenv/bin/terraform /usr/local/bin/terraform && \
    tfenv install latest && \
    tfenv use latest

# ── tofuenv (OpenTofu version manager) ───────────────────────────────────────
RUN git clone --depth=1 https://github.com/tofuutils/tofuenv.git /opt/tofuenv && \
    ln -s /opt/tofuenv/bin/tofuenv /usr/local/bin/tofuenv && \
    ln -s /opt/tofuenv/bin/tofu /usr/local/bin/tofu && \
    tofuenv install latest && \
    tofuenv use latest

# ── Terragrunt ────────────────────────────────────────────────────────────────
RUN TG_VERSION=$(curl -fsSL https://api.github.com/repos/gruntwork-io/terragrunt/releases/latest | jq -r '.tag_name') && \
    curl -fsSL "https://github.com/gruntwork-io/terragrunt/releases/download/${TG_VERSION}/terragrunt_linux_amd64" \
      -o /usr/local/bin/terragrunt && \
    chmod +x /usr/local/bin/terragrunt

# ── terraform-docs ────────────────────────────────────────────────────────────
RUN TFDOCS_VERSION=$(curl -fsSL https://api.github.com/repos/terraform-docs/terraform-docs/releases/latest | jq -r '.tag_name' | tr -d 'v') && \
    curl -fsSL "https://github.com/terraform-docs/terraform-docs/releases/download/v${TFDOCS_VERSION}/terraform-docs-v${TFDOCS_VERSION}-linux-amd64.tar.gz" \
      -o /tmp/tfdocs.tar.gz && \
    tar -xzf /tmp/tfdocs.tar.gz -C /tmp && \
    mv /tmp/terraform-docs /usr/local/bin/terraform-docs && \
    rm /tmp/tfdocs.tar.gz

COPY package.json pnpm-lock.yaml ./

# Production deps only — skip postinstall (electron-builder not in prod deps)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=builder /app/out/server ./out/server
COPY --from=builder /app/out/renderer/public/renderer ./out/public/renderer

# Copy pre-built native addon from builder (avoids network fetch in node-gyp)
COPY --from=builder /app/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build \
    ./node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Configure git to trust the workspace directory (safe.directory for arbitrary project paths)
RUN git config --global --add safe.directory '*'

CMD ["node", "out/server/index.mjs"]
