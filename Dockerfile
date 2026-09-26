# ==============================================================================
# Youthnic OMS - Production Multi-Stage Dockerfile for Hostinger VPS
# ==============================================================================

# STAGE 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache openssl libc6-compat

# Copy package definitions
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for TypeScript build)
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Build Frontend
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
RUN cd frontend && npm run build

# Build Backend
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# STAGE 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

# Install production runtime dependencies
RUN apk add --no-cache openssl wget ca-certificates tzdata

ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Kolkata
ENV CLIENT_DIST_PATH=/app/frontend/dist

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy generated Prisma Client from builder
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

# Copy compiled backend
COPY --from=builder /app/dist ./dist

# Copy compiled frontend assets for static serving
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/frontend/public ./frontend/public

# Copy brand logo and icon
COPY logo.png ./logo.png
COPY icon.png ./icon.png

# Create logs directory
RUN mkdir -p logs && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
