# ── Stage 1: build ────────────────────────────────────────────────────────────

FROM golang:1.22-alpine AS builder

# Install build dependencies needed for CGO-disabled static build.
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /app

# Cache module downloads before copying source so that Docker layer cache is
# invalidated only when go.mod / go.sum change, not on every source edit.
COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
      -ldflags="-s -w -extldflags '-static'" \
      -trimpath \
      -o /out/taskfire-worker \
      ./main.go

# ── Stage 2: minimal runtime image ────────────────────────────────────────────

FROM scratch

# TLS root certificates — required for any outbound HTTPS calls.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# IANA time-zone data — required by the cron scheduler.
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# The statically-linked binary is the only runtime artefact.
COPY --from=builder /out/taskfire-worker /taskfire-worker

# Prometheus metrics endpoint.
EXPOSE 9090

ENTRYPOINT ["/taskfire-worker"]
