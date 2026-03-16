```
████████╗ █████╗ ███████╗██╗  ██╗███████╗██╗██████╗ ███████╗
╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝██╔════╝██║██╔══██╗██╔════╝
   ██║   ███████║███████╗█████╔╝ █████╗  ██║██████╔╝█████╗
   ██║   ██╔══██║╚════██║██╔═██╗ ██╔══╝  ██║██╔══██╗██╔══╝
   ██║   ██║  ██║███████║██║  ██╗██║     ██║██║  ██║███████╗
   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝
```

<div align="center">

[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?style=flat-square&logo=go&logoColor=white)](https://golang.org)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-f0a500?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/ashah5123/taskfire/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/ashah5123/taskfire/actions)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/ashah5123/taskfire)

**A production-grade distributed background job engine with a priority queue, DAG dependency resolver, and real-time dashboard.**

[Getting Started](#getting-started) · [Deploy on Railway](#deploy-on-railway) · [Architecture](#architecture) · [API Reference](#api-reference) · [How It Works](#how-it-works) · [Contributing](#contributing)

</div>

---

## Overview

Taskfire is a self-hosted background job processing system built for engineers who need more than a simple task queue. Jobs are submitted through a typed REST API, persisted in PostgreSQL, and brokered through a Redis sorted-set priority queue to a pool of dynamically-scaling Go goroutines. The worker engine enforces DAG-based job dependencies — a job with unmet prerequisites stays blocked until every ancestor completes — and retries failures with per-type exponential backoff. A React 18 dashboard connects over WebSocket and renders live queue depth, per-minute throughput, worker utilization, and a dead-letter queue browser — all without a page refresh. Prometheus scrapes the worker's `/metrics` endpoint every 10 seconds, giving you 15 days of TSDB retention and a ready-made target for Grafana.

---

## Architecture

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                        Nginx :80                                  │
  │          rate-limit · gzip · CSP headers · SPA fallback          │
  └──────────────────┬──────────────────────────┬────────────────────┘
                     │  /api/*  /ws             │  / (static)
                     ▼                          ▼
         ┌───────────────────────┐   ┌────────────────────────┐
         │   Fastify API :3000   │   │  React 18 Dashboard    │
         │   TypeScript · Zod    │   │  Vite · Tailwind CSS   │
         │   @fastify/websocket  │◄──│  TanStack Query        │
         └──────┬──────────┬─────┘   │  Recharts              │
                │          │ WS push  └────────────────────────┘
         REST   │          │ every ~2 s
                │          │
  ┌─────────────▼──────┐  ┌▼───────────────────────────────────────┐
  │  PostgreSQL :5432  │  │  Redis :6379                            │
  │  jobs              │  │  taskfire:queue:high   (sorted set)     │
  │  job_dependencies  │  │  taskfire:queue:medium (sorted set)     │
  │  job_logs          │  │  taskfire:queue:low    (sorted set)     │
  │  job_metrics       │  │  taskfire:delayed      (sorted set)     │
  │  cron_jobs         │  │  taskfire:processing   (hash map)       │
  └─────────┬──────────┘  │  taskfire:dlq          (list)          │
            │              │  taskfire:lock:<id>    (string w/ TTL) │
            │              └──────────────┬─────────────────────────┘
            │                             │  BZPOPMIN (blocking pop)
            │                             ▼
            │              ┌──────────────────────────────────────┐
            │              │         Go Worker Pool               │
            │              │  ┌────────┐ ┌────────┐ ┌────────┐   │
            │              │  │ Worker │ │ Worker │ │ Worker │   │  MinWorkers–MaxWorkers
            │              │  │   #1   │ │   #2   │ │  #N    │   │  scale on queue depth
            │              │  └────────┘ └────────┘ └────────┘   │
            │              │                                       │
            │              │  ┌───────────────────────────────┐   │
            │              │  │  DAG Dependency Engine         │   │
            │              │  │  Kahn's BFS · cycle detection  │   │
            │              │  └───────────────────────────────┘   │
            │              │                                       │
            │              │  ┌───────────────────────────────┐   │
            │              │  │  Exponential Backoff Retry     │   │
            │              │  │  per-type config · jitter      │   │
            │              │  └───────────────────────────────┘   │
            │              │                                       │
            │              │  ┌───────────────────────────────┐   │
            │              │  │  Cron Scheduler               │   │
            │              │  │  robfig/cron · delayed poller  │   │
            │              │  └───────────────────────────────┘   │
            └──────────────│  job status writes · log appends     │
                           └──────────────────┬───────────────────┘
                                              │  /metrics
                                              ▼
                           ┌──────────────────────────────────────┐
                           │  Prometheus :9091                    │
                           │  10 s scrape · 15-day TSDB retention │
                           └──────────────────────────────────────┘
```

---

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| **Worker engine** | Go 1.22 | Goroutines make it trivial to run hundreds of concurrent workers with minimal overhead; the runtime scheduler handles preemption without OS threads |
| **Message broker** | Redis 7 sorted sets | `BZPOPMIN` gives atomic, blocking priority dequeue in O(log N); sorted sets make scheduling by score (timestamp or priority weight) a first-class operation |
| **Distributed locking** | Redis `SET NX PX` | Single-command compare-and-set with TTL prevents duplicate processing across restarts without a separate coordination service |
| **Persistence** | PostgreSQL 15 | JSONB payloads for schema-free job data, composite indexes for queue-claim queries, `job_dependencies` adjacency list for DAG traversal |
| **API server** | Fastify + TypeScript | Fastest Node.js HTTP framework by raw throughput; Zod schemas give compile-time and runtime type safety on every request body |
| **Real-time push** | WebSocket (`@fastify/websocket`) | Sub-second latency to the dashboard without polling; Redis pub/sub fans out job-state events to every connected browser |
| **Dashboard** | React 18 + Vite + Tailwind | Concurrent rendering for smooth live updates; Vite's ESM dev server with HMR for instant feedback; Tailwind utility classes eliminate stylesheet overhead |
| **Data fetching** | TanStack Query v5 | Stale-while-revalidate caching, automatic background refetch, and devtools built in — no custom fetch layer needed |
| **Charts** | Recharts | Composable SVG chart primitives that compose naturally with React's rendering model |
| **Metrics** | Prometheus client (Go) | Idiomatic instrumentation with counters, histograms, and gauges; Prometheus scrape model works without inbound access to the worker |
| **Reverse proxy** | Nginx 1.25 | Connection keep-alive, gzip, strict security headers, and SPA fallback in ~50 lines of config |
| **Containers** | Docker + Compose | Multi-stage Dockerfiles produce minimal images (~15 MB for the Go binary, ~50 MB for Node); Compose wires health checks and dependency ordering |

---

## Features

### Priority Queue with Three Lanes
Jobs are assigned `high`, `medium`, or `low` priority at submission time. Each maps to a Redis sorted set (`taskfire:queue:high/medium/low`) scored by enqueue timestamp, giving strict FIFO ordering within a lane. The dequeue Lua script checks high → medium → low in a single round-trip, ensuring high-priority work is never delayed by a backlog of lower-priority jobs.

### DAG Dependency Engine
Any job can declare `dependencies: [uuid, ...]` at creation time. Before a dequeued job begins execution, the Go worker queries the `job_dependencies` table and performs a BFS traversal up to 50 levels deep to verify every ancestor has `status = completed`. If any dependency is still pending or failed, the job is re-enqueued rather than executed. Cycle detection runs at submission time using Kahn's topological sort — circular dependency graphs are rejected with a 422 before they ever reach the queue.

### Dynamically Scaling Worker Pool
The pool starts `WORKER_MIN` goroutines and scales up to `WORKER_MAX` based on queue depth. A background scaler goroutine checks depth every 5 seconds: if depth exceeds the high watermark (50 jobs) and headroom exists, it spawns new workers; if depth drops below the low watermark (5 jobs), idle workers are signaled to exit. Workers track per-goroutine statistics (jobs processed, errors, last job start time) using atomic int64 counters — zero lock contention on the hot path.

### Exponential Backoff Retry
Each job type can register a custom retry configuration with `BaseDelay`, `MaxDelay`, `MaxRetries`, and `Multiplier`. The default profile uses 500 ms base, 30 s cap, 5 retries, and a 2× multiplier. Each retry interval is jittered ±10% to prevent thundering herd on a failing downstream. After `MaxRetries` exhausted, the job transitions to `dead` status and moves to the dead-letter queue, where it remains visible and replayable from the dashboard.

### Cron Scheduler
The scheduler runs inside the Go worker process using `robfig/cron` with second-granularity (six-field) expressions. Scheduled jobs land in a Redis sorted set (`taskfire:delayed`) scored by their Unix timestamp. A 1-second tick polls the sorted set and atomically moves any job whose score has passed into its priority lane — no separate scheduler process required.

### Real-Time Dashboard
The React dashboard opens a WebSocket to the API on load and receives a full state snapshot immediately, then incremental metrics pushes every ~2 seconds. It renders: live queue depth by priority lane, a 60-minute throughput time series (jobs/minute), failure rate with an alert badge above 5%, per-worker utilization, and a paginated dead-letter queue browser with one-click retry.

### Dead-Letter Queue Browser
Failed jobs that exhaust all retry attempts are archived to the DLQ with their last error message, retry count, and timestamp. The dashboard's DLQ panel lists them with full payload inspection and a `Retry` button that re-enqueues the job at its original priority, resetting the retry counter.

### Prometheus Observability
The worker exposes a `/metrics` endpoint with:

| Metric | Type | Labels |
|--------|------|--------|
| `taskfire_jobs_processed_total` | Counter | `job_type`, `priority` |
| `taskfire_jobs_failed_total` | Counter | `job_type`, `failure_reason` |
| `taskfire_retry_attempts_total` | Counter | `job_type` |
| `taskfire_job_processing_duration_seconds` | Histogram | `job_type` |
| `taskfire_queue_depth_gauge` | Gauge | `priority` |
| `taskfire_worker_utilization_gauge` | Gauge | `worker_id` |
| `taskfire_dead_letter_queue_size` | Gauge | — |
| `taskfire_active_workers_total` | Gauge | — |

---

## Deploy on Railway

Railway is the fastest way to get Taskfire running in the cloud — no server management, free tier available, and the managed Redis and PostgreSQL plugins wire up automatically.

### One-click deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/ashah5123/taskfire)

### Manual setup (5 minutes)

#### 1 — Create a Railway project

Sign up at [railway.app](https://railway.app) and create a new empty project.

#### 2 — Add managed infrastructure

In the Railway dashboard click **New Service → Database** and add:

| Plugin | Provides |
|--------|----------|
| **PostgreSQL** | `DATABASE_URL` — injected into worker + api automatically |
| **Redis** | `REDIS_URL` — injected into worker + api automatically |

Railway runs the Postgres schema automatically from `postgres/init.sql` if you mount it as an init script — otherwise run it manually via the Railway psql console after first deploy:

```sql
-- paste contents of postgres/init.sql into the Railway PostgreSQL console
```

#### 3 — Add the worker service

Click **New Service → GitHub Repo**, select this repo, and set:

| Setting | Value |
|---------|-------|
| Root Directory | `worker` |
| Builder | Dockerfile |

Under **Variables**, add:

```
REDIS_URL    = ${{Redis.REDIS_URL}}
DATABASE_URL = ${{Postgres.DATABASE_URL}}
WORKER_MIN   = 2
WORKER_MAX   = 8
LOG_LEVEL    = info
```

#### 4 — Add the API service

Add another GitHub service from the same repo:

| Setting | Value |
|---------|-------|
| Root Directory | `api` |
| Builder | Dockerfile |

Under **Variables**, add:

```
REDIS_URL    = ${{Redis.REDIS_URL}}
DATABASE_URL = ${{Postgres.DATABASE_URL}}
JWT_SECRET   = <run: openssl rand -hex 32>
NODE_ENV     = production
CORS_ORIGIN  = https://${{dashboard.RAILWAY_PUBLIC_DOMAIN}}
```

Railway injects `PORT` automatically — no need to set it.

#### 5 — Add the dashboard service

Add a third GitHub service:

| Setting | Value |
|---------|-------|
| Root Directory | `dashboard` |
| Builder | Dockerfile |

The dashboard is a static Vite build served by nginx. `VITE_API_URL` and `VITE_WS_URL` must be set as **build-time** variables (not runtime) because Vite bakes them into the bundle:

```
VITE_API_URL = https://${{api.RAILWAY_PUBLIC_DOMAIN}}
VITE_WS_URL  = wss://${{api.RAILWAY_PUBLIC_DOMAIN}}
```

#### 6 — Deploy

Click **Deploy** on each service (or push to `main` — Railway auto-deploys on push). The build order doesn't matter; the worker and API will retry their Redis/Postgres connections until the plugins are ready.

### Service URLs

After deploy, Railway assigns a public domain to each service. Find them under each service → **Settings → Networking → Public Domain**.

| Service | Notes |
|---------|-------|
| `dashboard` | Your app's public URL — share this |
| `api` | Referenced by dashboard as `VITE_API_URL` |
| `worker` | No public URL needed — internal only |

### Free tier notes

- Railway's free Starter plan includes 500 hours/month and $5 credit — enough to run Taskfire continuously.
- Set `WORKER_MIN=1` and `WORKER_MAX=4` on the free tier to stay within the shared vCPU limits.
- The `sleepApplication` setting is intentionally **not** enabled — the worker must stay live to process jobs. Upgrade to a Hobby plan ($5/month) for always-on services.

---

## Getting Started

### Prerequisites

| Tool | Minimum version |
|------|----------------|
| Docker | 24.x |
| Docker Compose | v2.x (plugin) |
| Go | 1.22 *(local dev only)* |
| Node.js | 20.x *(local dev only)* |

### One-command start

```bash
git clone https://github.com/aaravshah/taskfire.git
cd taskfire
cp .env.example .env
make build
make dev
```

That's it. All six services start with health checks. Open [http://localhost](http://localhost) for the dashboard.

| Service | URL |
|---------|-----|
| Dashboard | http://localhost |
| API | http://localhost:3000 |
| Worker metrics | http://localhost:9090/metrics |
| Prometheus | http://localhost:9091 |

### Enqueue your first job

```bash
curl -s -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "send-email",
    "payload": { "to": "user@example.com", "subject": "Hello from Taskfire" },
    "priority": "high",
    "max_retries": 3
  }' | jq .
```

### Running services individually

Start only infrastructure (Redis + Postgres):

```bash
make infra
```

Then in separate terminals:

```bash
# Install Node.js deps (first time only)
make install

# Go worker
make worker-dev

# Fastify API
make api-dev

# React dashboard (Vite dev server with HMR on :5173)
make dashboard-dev
```

### Running tests

```bash
make test           # all suites
make test-worker    # Go: testify + miniredis (22 tests)
make test-api       # Jest + supertest (29 tests)
make test-dashboard # Vitest + React Testing Library (40 tests)
```

---

## API Reference

All endpoints are prefixed with `/api`. Errors return `{ "error": "<message>" }` with an appropriate HTTP status code.

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/jobs` | Enqueue a new job |
| `GET` | `/api/jobs` | List jobs with filters and pagination |
| `GET` | `/api/jobs/:id` | Fetch a single job by UUID |
| `DELETE` | `/api/jobs/:id` | Cancel a pending job |
| `POST` | `/api/jobs/:id/retry` | Re-queue a failed or dead-letter job |
| `GET` | `/api/jobs/:id/logs` | Fetch structured execution logs |

#### `POST /api/jobs`

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "type":         "process-video",
    "payload":      { "video_id": "abc123", "resolution": "1080p" },
    "priority":     "high",
    "max_retries":  5,
    "scheduled_at": "2025-06-01T12:00:00Z",
    "dependencies": ["d290f1ee-6c54-4b01-90e6-d701748f0851"]
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✓ | Identifies the handler to invoke |
| `payload` | object | ✓ | Arbitrary JSON passed to the handler |
| `priority` | `"high"` \| `"medium"` \| `"low"` | — | Defaults to `"medium"` |
| `max_retries` | integer | — | Defaults to `3` |
| `scheduled_at` | ISO 8601 | — | Enqueue immediately if omitted |
| `dependencies` | UUID[] | — | Job will not run until all listed jobs are `completed` |

#### `GET /api/jobs`

```bash
curl 'http://localhost:3000/api/jobs?status=failed&priority=high&page=1&limit=25'
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | `pending` \| `active` \| `completed` \| `failed` \| `dead` |
| `priority` | string | `high` \| `medium` \| `low` |
| `type` | string | Filter by job type |
| `page` | integer | 1-based page number |
| `limit` | integer | Results per page (max 100) |

#### `GET /api/jobs/:id`

```bash
curl http://localhost:3000/api/jobs/d290f1ee-6c54-4b01-90e6-d701748f0851
```

#### `DELETE /api/jobs/:id`

Cancels a `pending` job. Returns `409` if the job is already `active` or `completed`.

```bash
curl -X DELETE http://localhost:3000/api/jobs/d290f1ee-6c54-4b01-90e6-d701748f0851
```

#### `POST /api/jobs/:id/retry`

Re-queues a `failed` or `dead` job at its original priority, resetting the retry counter to 0.

```bash
curl -X POST http://localhost:3000/api/jobs/d290f1ee-6c54-4b01-90e6-d701748f0851/retry
```

#### `GET /api/jobs/:id/logs`

```bash
curl http://localhost:3000/api/jobs/d290f1ee-6c54-4b01-90e6-d701748f0851/logs
```

Returns an array of `{ level, message, metadata, timestamp }` log entries written by the handler during execution.

---

### Metrics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/metrics/summary` | Queue depth by lane, status counts, failure rate, avg processing time |
| `GET` | `/api/metrics/throughput` | Jobs completed/failed per minute for the last 60 minutes |
| `GET` | `/api/metrics/workers` | Active worker count, in-flight job list, Redis discrepancy |
| `GET` | `/api/metrics/dead-letter` | Paginated DLQ with `limit` and `offset` query params |

#### `GET /api/metrics/summary`

```bash
curl http://localhost:3000/api/metrics/summary
```

```json
{
  "queue_depth":        { "high": 4, "medium": 12, "low": 1, "delayed": 3, "total": 20 },
  "dlq_depth":          2,
  "counts":             { "pending": 20, "active": 3, "completed": 8941, "failed": 47, "dead": 2, "total_processed": 8988 },
  "failure_rate":       0.0052,
  "avg_processing_ms":  142
}
```

#### `GET /api/metrics/throughput`

Returns 60 data points, one per minute, zero-filled for minutes with no activity.

```json
[
  { "time": "2025-01-01T10:00:00Z", "completed": 14, "failed": 1 },
  { "time": "2025-01-01T10:01:00Z", "completed": 22, "failed": 0 }
]
```

#### `GET /api/metrics/workers`

```json
{
  "active_workers":       8,
  "in_flight_redis":      8,
  "discrepancy":          0,
  "active_jobs": [
    { "job_id": "abc", "job_type": "send-email", "started_at": "...", "running_for_ms": 340 }
  ],
  "processing_ids_redis": ["abc", "def", "..."]
}
```

#### `GET /api/metrics/dead-letter`

```bash
curl 'http://localhost:3000/api/metrics/dead-letter?limit=25&offset=0'
```

---

### WebSocket

Connect to `ws://localhost/ws` (through Nginx) or `ws://localhost:3000/ws` (direct).

**Server → Client events:**

```jsonc
// Sent once on connection
{ "type": "snapshot", "payload": { /* full LiveMetrics */ } }

// Sent every ~2 seconds
{ "type": "metrics",  "payload": { /* LiveMetrics */ } }

// Sent whenever a job changes state
{ "type": "job_event", "payload": { "type": "completed", "job_id": "...", "job_type": "..." } }
```

**Client → Server:**

```json
{ "type": "ping" }
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | ✓ | `redis://localhost:6379` | Redis connection URL |
| `DATABASE_URL` | ✓ | `postgresql://taskfire:taskfire@localhost:5432/taskfire` | PostgreSQL connection URL |
| `POSTGRES_USER` | compose | `taskfire` | Postgres user (docker-compose init) |
| `POSTGRES_PASSWORD` | compose | `taskfire` | Postgres password |
| `POSTGRES_DB` | compose | `taskfire` | Postgres database name |
| `API_PORT` | — | `3000` | Port the Fastify server binds to |
| `CORS_ORIGIN` | — | `http://localhost` | Allowed CORS origin(s) |
| `JWT_SECRET` | prod | — | ≥ 32-char secret for signing tokens |
| `NODE_ENV` | — | `production` | `development` \| `production` \| `test` |
| `WORKER_MIN` | — | `4` | Minimum goroutines in the worker pool |
| `WORKER_MAX` | — | `32` | Maximum goroutines in the worker pool |
| `METRICS_PORT` | — | `9090` | Worker Prometheus `/metrics` port |
| `LOG_LEVEL` | — | `info` | `debug` \| `info` \| `warn` \| `error` |
| `VITE_API_URL` | — | *(empty — relative)* | API base URL baked into the dashboard bundle |
| `VITE_WS_URL` | — | *(empty — auto-detect)* | WebSocket origin baked into the bundle |

---

## How It Works

### Priority Queue Algorithm

The queue is built on three Redis sorted sets — `taskfire:queue:high`, `taskfire:queue:medium`, and `taskfire:queue:low`. When a job is enqueued, it is `ZADD`ed to the appropriate set with a score equal to its Unix nanosecond timestamp, establishing strict FIFO ordering within each lane. Dequeue is handled by a Lua script executed atomically on the Redis server:

```
1. BZPOPMIN taskfire:queue:high   (blocking, 1 s timeout)
2. If empty → BZPOPMIN taskfire:queue:medium
3. If empty → BZPOPMIN taskfire:queue:low
4. On hit:
   a. SET taskfire:lock:<job_id> 1 NX PX 30000   (30 s distributed lock)
   b. HSET taskfire:processing <job_id> <payload>
   c. Return payload to caller
```

The lock prevents a re-enqueued retry from being claimed by two workers simultaneously if the original worker stalls before acknowledging. Ack removes the hash entry and deletes the lock. Nack removes the hash entry, deletes the lock, and re-adds the job to its priority lane for another worker to claim.

Delayed jobs are stored in `taskfire:delayed` scored by their scheduled Unix timestamp. The cron scheduler's 1-second poller calls `ZRANGEBYSCORE taskfire:delayed 0 <now>`, atomically removes matching members with `ZREM`, and `ZADD`s them into their priority lane.

### DAG Dependency Engine

Job dependencies are modeled as a directed acyclic graph stored in the `job_dependencies` table (an adjacency list of `(job_id, depends_on_job_id)` edges). When a job is submitted with `dependencies`, the engine:

1. **Validates** the proposed graph by loading the full transitive closure of the new job's ancestors and running Kahn's algorithm. If `|sorted| < |nodes|`, a cycle was detected and the submission is rejected with `422 Unprocessable Entity`.
2. **Gates execution** at dequeue time: the worker loads all direct and transitive predecessors up to 50 BFS levels deep, queries their statuses in a single `SELECT`, and checks that every ancestor has `status = 'completed'`. If any ancestor is `pending`, `active`, or `failed`, the job is re-enqueued with a short delay rather than executed immediately.

This means dependency checks are enforced by the worker, not the API, so they survive process restarts — a job will keep re-checking its ancestors until all are complete.

### Exponential Backoff

Each job type can be registered with a custom `retry.Config`:

```go
type Config struct {
    BaseDelay  time.Duration // initial wait (default: 500 ms)
    MaxDelay   time.Duration // ceiling (default: 30 s)
    MaxRetries int           // attempts before DLQ (default: 5)
    Multiplier float64       // growth factor (default: 2.0)
}
```

The delay for attempt *n* is:

```
delay = min(BaseDelay × Multiplier^n, MaxDelay) × jitter
jitter ∈ [0.9, 1.1]   (uniform random ±10%)
```

Jitter prevents multiple failing jobs of the same type from retrying in lockstep and hammering a recovering downstream service. After `MaxRetries` attempts, the job's status is set to `dead`, it is written to the Redis DLQ list, and its final error is stored in Postgres for inspection.

---

## Project Layout

```
taskfire/
├── worker/                   Go worker engine
│   ├── main.go               Startup, signal handling, graceful shutdown
│   ├── pool/                 Dynamic goroutine pool with watermark autoscaling
│   ├── queue/                Redis priority queue (Lua atomic scripts)
│   ├── processor/            Job executor: handler registry, retry, DLQ routing
│   ├── scheduler/            robfig/cron + delayed-job 1 s poller
│   ├── dag/                  Kahn's BFS topological sort + dependency gating
│   ├── retry/                Per-type exponential backoff with jitter
│   ├── metrics/              Prometheus registry: counters, histograms, gauges
│   └── Dockerfile            Multi-stage: golang:1.22 builder → alpine runtime
├── api/                      Node.js Fastify API
│   ├── src/
│   │   ├── index.ts          Server bootstrap, plugin registration, shutdown
│   │   ├── routes/           jobs.ts · metrics.ts
│   │   ├── services/         redis.ts · postgres.ts (singleton clients)
│   │   ├── websocket/        handler.ts (snapshot, heartbeat, pub/sub fan-out)
│   │   └── types/            job.ts (Zod schemas + TypeScript interfaces)
│   └── Dockerfile            Multi-stage: node:20 builder → slim runtime
├── dashboard/                React 18 SPA
│   ├── src/
│   │   ├── App.tsx           Shell: sidebar navigation + dark mode toggle
│   │   ├── components/       MetricCard · JobTable · ThroughputChart ·
│   │   │                     FailureRateChart · QueueDepthChart ·
│   │   │                     WorkerUtilization · DeadLetterPanel
│   │   ├── hooks/            useWebSocket · useJobs
│   │   ├── api/              client.ts (Axios + axios-retry + ApiError)
│   │   └── types/            job.ts
│   └── Dockerfile            Multi-stage: node:20 Vite build → nginx static
├── postgres/
│   └── init.sql              Schema, enums, triggers, covering indexes, views
├── nginx/
│   └── nginx.conf            Rate limiting, gzip, security headers, SPA fallback
├── prometheus/
│   └── prometheus.yml        10 s scrape interval, worker + API targets
├── docker-compose.yml        Six-service orchestration with health checks
├── Makefile                  Dev, build, test, lint, and deploy targets
└── .env.example              Annotated environment variable template
```

---

## Makefile Reference

```
make dev             Start all services (docker compose up --build -d)
make infra           Start Redis + Postgres only
make build           Build all Docker images
make push            Tag and push to REGISTRY (default: ghcr.io/aaravshah)
make migrate         Apply postgres/init.sql schema
make logs            Tail logs from all services
make stop            Stop all running containers
make clean           Remove containers, volumes, and built binaries
make ps              Show running container status

make test            Run all test suites
make test-worker     Go worker tests (testify + miniredis)
make test-api        Node.js API tests (Jest + supertest)
make test-dashboard  React component tests (Vitest + RTL)

make lint            go vet + eslint across all packages
make install         npm ci for api/ and dashboard/
make worker-dev      Run Go worker locally (requires local Go)
make api-dev         Run Fastify API locally
make dashboard-dev   Run Vite dev server on :5173 with HMR
```

---

## Contributing

Contributions are welcome. Here's how to get oriented:

```bash
# Fork and clone
git clone https://github.com/<your-fork>/taskfire.git
cd taskfire

# Start infrastructure
make infra

# Install deps and run tests
make install
make test

# Make your changes, then verify
make test
make lint
```

**Conventions:**
- Go code: `gofmt` formatted, packages named after their directory, errors wrapped with context using `fmt.Errorf("...: %w", err)`
- TypeScript: strict mode enabled, Zod schemas for all external data, no `any`
- Commit messages: imperative mood, present tense (`add retry jitter`, not `added`)
- Tests: new behaviour should come with a test; prefer table-driven tests in Go

Open an issue first for significant changes so the approach can be discussed before implementation.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute. See the [LICENSE](LICENSE) file for the full text.
