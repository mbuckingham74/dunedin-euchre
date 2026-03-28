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

CMD ["node", "server.js"]
