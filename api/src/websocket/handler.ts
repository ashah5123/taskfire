import { WebSocket } from 'ws'
import { FastifyRequest } from 'fastify'
import {
  getQueueDepthByLane,
  getDLQDepth,
  subscribeToEvents,
} from '../services/redis'
import { getStatusCounts } from '../services/postgres'
import type { JobEvent } from '../types/job'

// ── Client registry ───────────────────────────────────────────────────────────

const clients = new Set<WebSocket>()

export function broadcast(data: unknown): void {
  const message = JSON.stringify(data)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message, (err) => {
        if (err) clients.delete(ws)
      })
    }
  }
}

// ── Redis pub/sub event forwarding ────────────────────────────────────────────

let unsubscribe: (() => Promise<void>) | null = null

export async function startEventForwarding(): Promise<void> {
  unsubscribe = await subscribeToEvents((message) => {
    try {
      const event = JSON.parse(message) as JobEvent
      broadcast({ type: 'job_event', payload: event })
    } catch {
      // Ignore malformed messages from Redis.
    }
  })
}

export async function stopEventForwarding(): Promise<void> {
  if (unsubscribe) {
    await unsubscribe()
    unsubscribe = null
  }
}

// ── Periodic metrics push ─────────────────────────────────────────────────────

let metricsInterval: ReturnType<typeof setInterval> | null = null

export function startMetricsBroadcast(): void {
  metricsInterval = setInterval(async () => {
    if (clients.size === 0) return
    try {
      const [queueDepth, dlqDepth, statusCounts] = await Promise.all([
        getQueueDepthByLane(),
        getDLQDepth(),
        getStatusCounts(),
      ])
      broadcast({
        type: 'metrics',
        payload: {
          queue_depth: queueDepth,
          dlq_depth: dlqDepth,
          active_jobs: statusCounts.active,
          pending_jobs: statusCounts.pending,
          timestamp: new Date().toISOString(),
        },
      })
    } catch {
      // Redis/Postgres may be temporarily unavailable; skip this tick.
    }
  }, 2000)
}

export function stopMetricsBroadcast(): void {
  if (metricsInterval !== null) {
    clearInterval(metricsInterval)
    metricsInterval = null
  }
}

// ── WebSocket connection handler ──────────────────────────────────────────────

export function wsHandler(socket: WebSocket, _req: FastifyRequest): void {
  clients.add(socket)

  socket.send(
    JSON.stringify({
      type: 'connected',
      payload: {
        message: 'Taskfire live updates connected',
        clients: clients.size,
        timestamp: new Date().toISOString(),
      },
    })
  )

  socket.on('message', (raw) => {
    let msg: unknown
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      socket.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON' } }))
      return
    }

    if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      (msg as { type: unknown }).type === 'ping'
    ) {
      socket.send(JSON.stringify({ type: 'pong', payload: { timestamp: new Date().toISOString() } }))
    }
  })

  socket.on('close', () => {
    clients.delete(socket)
  })

  socket.on('error', () => {
    clients.delete(socket)
  })
}
