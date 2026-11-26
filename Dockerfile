# ==========================================
# MusicFlow Downloader Worker — Dockerfile
# Production Container for Cloud & VPS
# ==========================================

# Stage 1: Build TypeScript source code
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy root workspace manifests
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/worker/package.json ./apps/worker/

# Install build dependencies
RUN npm ci

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

# Compile TypeScript
RUN npm --workspace=@musicflow/shared run build && \
    npm --workspace=@musicflow/worker run build

# ==========================================
# Stage 2: Production Runtime
# ==========================================
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install system dependencies: FFmpeg, FFprobe, Python3, and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Verify binaries
RUN ffmpeg -version | head -n 1 && \
    python3 --version && \
    /usr/local/bin/yt-dlp --version

# Set environment
ENV NODE_ENV=production \
    PORT=4000 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    TEMP_DIR=/app/tmp/musicflow

# Copy workspace package manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/worker/package.json ./apps/worker/

# Install only production dependencies
RUN npm ci --omit=dev

# Copy compiled files from builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

# Create temp working directory with write permissions for node user
RUN mkdir -p /app/tmp/musicflow && chown -R node:node /app

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c 'curl -fsS "http://localhost:${PORT:-4000}/ready" || exit 1'

CMD ["node", "apps/worker/dist/index.js"]
