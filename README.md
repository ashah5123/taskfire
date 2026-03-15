# Taskfire

A high-throughput background job processing system with a real-time dashboard.

## Stack

| Layer | Tech |
|---|---|
| Worker engine | Go — goroutine pool, exponential backoff, DAG dependencies, cron scheduler |
| Broker | Redis — sorted-set priority queue, processing set, DLQ |
| API | Node.js + Fastify + TypeScript |
| Persistence | PostgreSQL |
| Dashboard | React + TypeScript + Vite + TailwindCSS + Recharts |
| Metrics | Prometheus + Go client |
| Proxy | Nginx |

## Quick start

```bash
cp .env.example .env
make build
make up
```

- Dashboard: http://localhost (via nginx) or http://localhost:5173 (direct)
- API: http://localhost:3001
- Prometheus: http://localhost:9091
- Worker metrics: http://localhost:9090/metrics

## Local development

```bash
# Start backing services
make infra

# In separate terminals:
make worker-dev
make api-dev
make dashboard-dev
```

## API

### Jobs

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/jobs` | Create job |
| `GET` | `/api/jobs` | List jobs (`?status=&page=&limit=`) |
| `GET` | `/api/jobs/:id` | Get single job |
| `DELETE` | `/api/jobs/:id` | Cancel pending job |
| `POST` | `/api/jobs/:id/retry` | Retry failed/dead job |

### Metrics

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/metrics/overview` | Queue depth, status counts |
| `GET` | `/api/metrics/throughput` | Jobs/min last hour |
| `GET` | `/api/metrics/failure-rate` | Failure rate last hour |

### WebSocket

Connect to `ws://localhost:3001/ws` — receives `metrics` events every 2 seconds.

## Job payload example

```json
{
  "type": "email",
  "payload": { "to": "user@example.com", "subject": "Hello" },
  "priority": 5,
  "max_retries": 3
}
```

## Architecture

```
Client → Nginx → API (Fastify) → Redis (priority queue)
                    ↓                      ↓
               PostgreSQL          Worker pool (Go)
                    ↑                      ↓
               job events          Processor → handlers
                                           ↓
                                     Prometheus metrics
```

Workers dequeue jobs via `BZPOPMIN` on a Redis sorted set scored by `-priority`. Failed jobs are retried with exponential backoff up to `max_retries`, then moved to the DLQ. The scheduler (robfig/cron) enqueues cron jobs on their schedule. The WebSocket handler pushes live metrics to dashboard clients every 2 seconds.
