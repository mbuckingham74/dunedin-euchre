FROM node:22.22-bookworm-slim AS deps

# better-sqlite3 compiles a native addon during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.22-bookworm-slim AS runner

# Create unprivileged app user
RUN groupadd -r appgroup && useradd -r -g appgroup appuser

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p data uploads logs && chown -R appuser:appgroup /app

EXPOSE 3456

USER appuser

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3456/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
