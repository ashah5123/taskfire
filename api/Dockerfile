# ── Stage 1: build ────────────────────────────────────────────────────────────

FROM node:20-alpine AS builder

# Install build tools for native addons (e.g. pg).
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Layer-cache: install dependencies before copying full source so that a source
# change does not invalidate the npm ci layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npm run build

# Prune devDependencies from node_modules after the build so that only
# production packages are copied to the final image.
RUN npm prune --omit=dev

# ── Stage 2: production runtime ───────────────────────────────────────────────

FROM node:20-alpine

RUN apk add --no-cache dumb-init

# Run as non-root.
USER node
WORKDIR /app

# Copy pruned node_modules from builder so the final layer has no devDeps.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist         ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

EXPOSE 3000

# dumb-init forwards signals to the node process so that graceful shutdown
# (SIGTERM handling in src/index.ts) works correctly inside Docker.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
