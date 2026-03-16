# Taskfire

A production-grade distributed background job processing system.  Jobs are
enqueued via a REST API, persisted in PostgreSQL, brokered through a Redis
priority queue, and executed by a pool of Go worker goroutines.  A React
dashboard provides real-time visibility into queue depth, throughput, failure
rates, and worker utilisation over a WebSocket connection.

---

## Architecture

```
                              ┌─────────────────────────────────────┐
                              │              Nginx :80               │
                              │  rate-limit · gzip · CSP headers     │
                              └────────────┬──────────┬─────────────┘
                                           │          │
                         /api/* · /ws      │          │  /  (static)
                                           ▼          ▼
                              ┌────────────────┐  ┌──────────────────┐
                              │  Fastify API   │  │  React Dashboard │
                              │  Node.js :3000 │  │  nginx :80       │
                              └───┬────────┬───┘  └──────────────────┘
                                  │        │ WebSocket
                          REST    │        │ live metrics push (2 s)
                                  │        │
            ┌─────────────────────▼──┐  ┌──▼──────────────────────┐
            │  PostgreSQL :5432      │  │  Redis :6379             │
            │  jobs                  │  │  taskfire:queue:high     │
            │  job_dependencies      │  │  taskfire:queue:medium   │
            │  job_logs              │  │  taskfire:queue:low      │
            │  job_metrics           │  │  taskfire:delayed        │
            │  cron_jobs             │  │  taskfire:processing     │
            └────────────────────────┘  │  taskfire:dlq            │
                        ▲               └──────────────┬───────────┘
                        │                              │ BZPOPMIN
                        │                              ▼
                        │               ┌──────────────────────────┐
                        │               │      Go Worker Pool       │
                        │               │  goroutines × WORKER_COUNT│
                        └───────────────│  DAG dependency engine    │
                      job status        │  exponential-backoff retry│
                      / log writes      │  cron scheduler           │
                                        └──────────┬───────────────┘
                                                   │ /metrics
                                                   ▼
                                        ┌──────────────────────────┐
                                        │  Prometheus :9091         │
                                        │  15-day TSDB retention    │
                                        └──────────────────────────┘
```

---

## Tech stack

| Layer            | Technology                                      |
|------------------|-------------------------------------------------|
| Worker engine    | Go 1.22 — goroutine pool, DAG resolver, cron    |
| Message broker   | Redis 7 — sorted-set priority queue, DLQ        |
| API server       | Node.js 20 · Fastify · TypeScript               |
| Persistence      | PostgreSQL 15                                   |
| Dashboard        | React 18 · TypeScript · Vite · TailwindCSS      |
| Charts           | Recharts                                        |
| Metrics          | Prometheus + Go client library                  |
| Reverse proxy    | Nginx 1.25                                      |
| Containerisation | Docker · Docker Compose                         |

---

## Prerequisites

| Tool            | Minimum version |
|-----------------|----------------|
| Docker          | 24.x           |
| Docker Compose  | v2.x (plugin)  |
| Go              | 1.22 *(local dev only)* |
| Node.js         | 20.x *(local dev only)* |

---

## Running with Docker Compose

```bash
# 1. Copy the environment template and adjust values if needed.
cp .env.example .env

# 2. Build all images.
make build

# 3. Start every service in the background.
make dev

# 4. Tail logs across all services.
make logs
```

Service URLs once running:

| Service            | URL                             |
|--------------------|---------------------------------|
| Dashboard (nginx)  | http://localhost                |
| Dashboard (direct) | http://localhost:5173           |
| API                | http://localhost:3000           |
| Worker metrics     | http://localhost:9090/metrics   |
| Prometheus         | http://localhost:9091           |

---

## Running services individually

Start only the infrastructure (Redis + Postgres):

```bash
make infra
```

Then run each service in a separate terminal:

```bash
# Go worker
make worker-dev          # or: cd worker && go run ./main.go

# Fastify API
make api-dev             # or: cd api && npm run dev

# React dashboard (Vite dev server with HMR)
make dashboard-dev       # or: cd dashboard && npm run dev
```

Install Node.js dependencies before first run:

```bash
make install
```

---

## API reference

All endpoints are prefixed with `/api`.

### Jobs

| Method   | Path                  | Description                                      |
|----------|-----------------------|--------------------------------------------------|
| `POST`   | `/api/jobs`           | Enqueue a new job                                |
| `GET`    | `/api/jobs`           | List jobs — filterable by `status`, `priority`, `type` |
| `GET`    | `/api/jobs/:id`       | Get a single job by UUID                        |
| `DELETE` | `/api/jobs/:id`       | Cancel a pending job                            |
| `POST`   | `/api/jobs/:id/retry` | Re-queue a failed or dead-letter job            |
| `GET`    | `/api/jobs/:id/logs`  | Fetch structured logs for a job                 |

#### Create job — request body

```json
{
  "type":         "send-email",
  "payload":      { "to": "user@example.com", "subject": "Welcome" },
  "priority":     "high",
  "max_retries":  3,
  "scheduled_at": "2025-01-01T09:00:00Z",
  "dependencies": ["<uuid-of-prerequisite-job>"]
}
```

`priority` accepts `"high"`, `"medium"` (default), or `"low"`.
`scheduled_at` is optional — omit to enqueue immediately.
`dependencies` is optional — job will not start until all listed jobs are `completed`.

#### List jobs — query parameters

| Parameter  | Type    | Example      |
|------------|---------|--------------|
| `status`   | string  | `pending`    |
| `priority` | string  | `high`       |
| `type`     | string  | `send-email` |
| `page`     | integer | `2`          |
| `limit`    | integer | `25`         |

### Metrics

| Method | Path                        | Description                              |
|--------|-----------------------------|------------------------------------------|
| `GET`  | `/api/metrics/summary`      | Queue depth by lane, status counts, failure rate |
| `GET`  | `/api/metrics/throughput`   | Jobs completed/failed per minute (last hour) |
| `GET`  | `/api/metrics/workers`      | Active worker count and in-flight jobs   |
| `GET`  | `/api/metrics/dead-letter`  | Paginated dead-letter queue listing      |

### WebSocket

Connect to `ws://localhost/ws` (through nginx) or `ws://localhost:3000/ws` (direct).

The server pushes two event types:

```jsonc
// Sent once on connection — full state snapshot
{ "type": "snapshot", "payload": { /* LiveMetrics */ } }

// Sent every ~2 seconds while connected
{ "type": "metrics",  "payload": { /* LiveMetrics */ } }

// Sent whenever a job changes state
{ "type": "job_event", "payload": { "type": "completed", "job_id": "...", ... } }
```

Send a ping:

```json
{ "type": "ping" }
```

---

## Environment variables

| Variable          | Required | Default                            | Description                                      |
|-------------------|----------|------------------------------------|--------------------------------------------------|
| `REDIS_URL`       | yes      | `redis://localhost:6379`           | Redis connection URL                             |
| `DATABASE_URL`    | yes      | `postgresql://…@localhost/taskfire`| PostgreSQL connection URL                        |
| `POSTGRES_USER`   | compose  | `taskfire`                         | Postgres superuser (used by docker-compose init) |
| `POSTGRES_PASSWORD` | compose | `taskfire`                        | Postgres password                                |
| `POSTGRES_DB`     | compose  | `taskfire`                         | Postgres database name                           |
| `API_PORT`        | no       | `3000`                             | Port the API server listens on                   |
| `CORS_ORIGIN`     | no       | `http://localhost`                 | Allowed CORS origin(s)                           |
| `JWT_SECRET`      | prod     | —                                  | ≥32-char secret for signing tokens               |
| `NODE_ENV`        | no       | `production`                       | `development` \| `production` \| `test`          |
| `WORKER_COUNT`    | no       | `10`                               | Goroutines in the worker pool                    |
| `METRICS_PORT`    | no       | `9090`                             | Worker Prometheus endpoint port                  |
| `LOG_LEVEL`       | no       | `info`                             | `debug` \| `info` \| `warn` \| `error`           |
| `VITE_API_URL`    | no       | *(empty — relative)*              | API base URL baked into the dashboard bundle     |
| `VITE_WS_URL`     | no       | *(empty — auto-detect)*           | WebSocket origin baked into the dashboard bundle |

---

## Makefile targets

```
make dev            Start all services (docker compose up --build)
make build          Build all Docker images
make push           Tag and push images to REGISTRY (default: ghcr.io/aaravshah)
make migrate        Apply postgres/init.sql schema
make logs           Tail logs from all services
make stop           Stop all running containers
make clean          Remove containers, volumes and built binaries
make test           Run all tests (Go worker + Node.js API)
make infra          Start Redis + Postgres only
make worker-dev     Run Go worker locally
make api-dev        Run Node.js API locally
make dashboard-dev  Run React dashboard dev server
make install        npm ci for api/ and dashboard/
make lint           go vet + eslint across all packages
make ps             Show running container status
```

---

## Project layout

```
taskfire/
├── worker/              Go worker engine
│   ├── main.go
│   ├── pool/            Dynamic goroutine pool
│   ├── queue/           Redis priority queue (Lua scripts)
│   ├── processor/       Job executor with retry logic
│   ├── scheduler/       Cron + delayed-job poller
│   ├── dag/             DAG dependency resolver (Kahn's BFS)
│   ├── retry/           Exponential backoff
│   ├── metrics/         Prometheus metrics registry
│   └── Dockerfile
├── api/                 Node.js Fastify API
│   ├── src/
│   │   ├── index.ts     Server bootstrap + graceful shutdown
│   │   ├── routes/      jobs.ts · metrics.ts
│   │   ├── services/    redis.ts · postgres.ts
│   │   ├── websocket/   handler.ts (heartbeat, snapshot, pub/sub)
│   │   └── types/       job.ts (Zod schemas + TypeScript interfaces)
│   └── Dockerfile
├── dashboard/           React 18 SPA
│   ├── src/
│   │   ├── App.tsx      Shell with sidebar navigation + dark mode
│   │   ├── components/  MetricCard · JobTable · charts · DeadLetterPanel
│   │   ├── hooks/       useWebSocket · useJobs
│   │   ├── api/         client.ts (Axios + retry + ApiError)
│   │   └── types/       job.ts
│   └── Dockerfile
├── postgres/
│   └── init.sql         Schema, enums, triggers, indexes, views
├── nginx/
│   └── nginx.conf       Rate limiting, gzip, security headers, SPA fallback
├── prometheus/
│   └── prometheus.yml   10 s scrape interval, worker + API targets
├── docker-compose.yml
├── Makefile
└── .env.example
```
