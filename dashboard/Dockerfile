# ── Stage 1: build ────────────────────────────────────────────────────────────

FROM node:20-alpine AS builder

WORKDIR /app

# Layer-cache: install dependencies before copying source.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_API_URL and VITE_WS_URL are baked into the static bundle at build time.
# Pass them as build args so docker-compose (or CI) can inject the correct
# values for each environment without modifying source files.
ARG VITE_API_URL=""
ARG VITE_WS_URL=""
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}

RUN npm run build

# ── Stage 2: nginx static file server ─────────────────────────────────────────

FROM nginx:1.25-alpine

# Remove the default nginx config and replace with the application-specific one.
RUN rm /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Validate config at image build time so a bad config fails the build
# rather than silently crashing at runtime.
RUN nginx -t

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
