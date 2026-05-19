FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
RUN mkdir -p /app/media
EXPOSE 4000
# Railway runs migrations via preDeployCommand in railway.json. For
# docker-compose / local Docker we still want migrations at container start,
# so the entrypoint runs them only when MIGRATE_ON_BOOT=1 (set in compose).
CMD ["sh", "-c", "if [ \"$MIGRATE_ON_BOOT\" = \"1\" ]; then node dist/db/migrate.js; fi && node dist/server.js"]
