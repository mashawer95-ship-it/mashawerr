# Mashawerr API – Production Dockerfile
# Multi-stage build: keeps final image lean (no devDependencies)

# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy only package files first (better layer caching)
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# ── Stage 2: Final image ─────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Remove dev/test files from final image
RUN rm -f test-*.js fix_index.js

# Ensure uploads dir exists and is writable
RUN mkdir -p uploads && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "app.js"]
