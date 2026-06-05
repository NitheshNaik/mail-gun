# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — Node 20 Alpine (used for both API server and Worker)
# The CMD is overridden per-service in docker-compose.yml
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine

# Install build tools required by better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy dependency manifests first (Docker layer cache optimization)
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy application source
COPY . .

# Create uploads directory
RUN mkdir -p uploads

# Expose API port (only meaningful for the api service)
EXPOSE 3001

# Default command — overridden by docker-compose per service
CMD ["node", "server.js"]
