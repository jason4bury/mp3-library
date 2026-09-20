# --- Build stage: install deps (better-sqlite3 needs build tools if no prebuilt binary matches the arch) ---
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev

# --- Runtime stage ---
FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

VOLUME ["/data"]

# Backs Docker's own container health status (visible via `docker ps` / `docker inspect`, and
# what tools like Portainer show) with GET /healthz. Uses Node itself to make the request rather
# than adding curl/wget — this runtime image is deliberately slim and doesn't have either.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
