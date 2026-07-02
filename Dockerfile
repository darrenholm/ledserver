# Combined frontend + backend image. Used by Railway (single service deploy).
# docker-compose still uses the separate backend/Dockerfile and frontend/Dockerfile
# so the dev workflow with nginx + Postgres in containers keeps working.

# --- Stage 1: build frontend (Vite) ---
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src
# Single-origin deploy: frontend hits /api on the same host as itself.
ENV VITE_API_BASE_URL=/api
RUN npm run build

# --- Stage 2: build backend (TypeScript) ---
FROM node:22-alpine AS backend-builder
WORKDIR /backend
COPY backend/package*.json backend/tsconfig.json ./
RUN npm install
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN npm run build

# --- Stage 3: runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg/ffprobe: used by services/videoProbe to read codec/fps/dimensions from
# uploaded videos so VNNOX VIDEO widgets get the metadata the Taurus needs to
# actually play (not just show a frozen frame).
RUN apk add --no-cache ffmpeg
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=backend-builder /backend/dist ./dist
COPY --from=backend-builder /backend/migrations ./migrations
COPY --from=frontend-builder /frontend/dist ./public
RUN mkdir -p /app/media
EXPOSE 4000
CMD ["node", "dist/server.js"]
