FROM node:22-bookworm-slim

# Build deps for better-sqlite3 (native module)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (layer cache)
COPY package*.json ./
RUN npm install --production --no-audit --no-fund

# Copy source
COPY . .

# Runtime directories (data + uploads live in named volumes)
RUN mkdir -p data uploads logs

EXPOSE 3456

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3456/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
