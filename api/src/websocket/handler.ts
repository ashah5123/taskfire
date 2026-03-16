import { WebSocket } from 'ws'
import { FastifyRequest } from 'fastify'
import {
  getQueueDepthByLane,
  getDLQDepth,
  subscribeToEvents,
} from '../services/redis'
import { getStatusCounts } from '../services/postgres'
import type { JobEvent } from '../types/job'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WsMessage {
  type: string
  payload?: unknown
}

interface TrackedClient {
  socket:  WebSocket
  isAlive: boolean
  connectedAt: string
}

// ── Client registry ───────────────────────────────────────────────────────────

const clients = new Map<WebSocket, TrackedClient>()

function register(socket: WebSocket): TrackedClient {
  const entry: TrackedClient = {
    socket,
    isAlive:     true,
    connectedAt: new Date().toISOString(),
  }
  clients.set(socket, entry)
  return entry
}

function remove(socket: WebSocket): void {
  clients.delete(socket)
}

// ── Broadcasting ──────────────────────────────────────────────────────────────

export function broadcast(data: unknown): void {
  if (clients.size === 0) return
  const message = JSON.stringify(data)
  for (const [socket] of clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message, (err) => {
        if (err) remove(socket)
      })
    } else if (socket.readyState === WebSocket.CLOSED ||
               socket.readyState === WebSocket.CLOSING) {
      remove(socket)
    }
  }
}

function sendTo(socket: WebSocket, data: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(data), (err) => {
    if (err) remove(socket)
  })
}

// ── Initial state snapshot ────────────────────────────────────────────────────

/**
 * Build and send a state snapshot to a newly connected client so the dashboard
 * renders meaningful data immediately instead of waiting for the next broadcast.
 */
async function sendSnapshot(socket: WebSocket): Promise<void> {
  try {
    const [queueDepth, dlqDepth, statusCounts] = await Promise.all([
      getQueueDepthByLane(),
      getDLQDepth(),
      getStatusCounts(),
    ])
    sendTo(socket, {
      type: 'snapshot',
      payload: {
        queue_depth:  queueDepth,
        dlq_depth:    dlqDepth,
        active_jobs:  statusCounts.active,
        pending_jobs: statusCounts.pending,
        counts:       statusCounts,
        timestamp:    new Date().toISOString(),
      },
    })
  } catch {
    // Backing stores may not be reachable yet on first connect; skip silently.
  }
}

// ── Redis pub/sub event forwarding ────────────────────────────────────────────

let stopForwarding: (() => Promise<void>) | null = null

export async function startEventForwarding(): Promise<void> {
  stopForwarding = await subscribeToEvents((_channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as JobEvent
      broadcast({ type: 'job_event', payload: event })
    } catch { /* ignore malformed Redis messages */ }
  })
}

export async function stopEventForwarding(): Promise<void> {
  if (stopForwarding) {
    await stopForwarding()
    stopForwarding = null
  }
}

// ── Periodic metrics broadcast ────────────────────────────────────────────────

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
          queue_depth:  queueDepth,
          dlq_depth:    dlqDepth,
          active_jobs:  statusCounts.active,
          pending_jobs: statusCounts.pending,
          counts:       statusCounts,
          timestamp:    new Date().toISOString(),
        },
      })
    } catch { /* skip tick on transient errors */ }
  }, 2_000)
}

export function stopMetricsBroadcast(): void {
  if (metricsInterval !== null) {
    clearInterval(metricsInterval)
    metricsInterval = null
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
//
// Every 30 s we send a WS-level ping frame to every tracked client.
// If the client has not responded with a pong since the last ping cycle its
// connection is considered dead and is terminated. The browser WebSocket API
// handles pong replies automatically, so no application-level handling is
// required on the client side.

let heartbeatInterval: ReturnType<typeof setInterval> | null = null

export function startHeartbeat(): void {
  heartbeatInterval = setInterval(() => {
    for (const [socket, entry] of clients) {
      if (!entry.isAlive) {
        // No pong received since the last ping — connection is dead.
        socket.terminate()
        remove(socket)
        continue
      }
      // Mark as unresponsive until we receive the pong.
      entry.isAlive = false
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping()
      }
    }
  }, 30_000)
}

export function stopHeartbeat(): void {
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
}

// ── WebSocket connection handler ──────────────────────────────────────────────

export function wsHandler(socket: WebSocket, _req: FastifyRequest): void {
  const entry = register(socket)

  // Restore the liveness flag whenever a pong frame arrives.
  socket.on('pong', () => {
    entry.isAlive = true
  })

  // Send the welcome frame synchronously so the client knows it's connected,
  // then dispatch the full snapshot asynchronously.
  sendTo(socket, {
    type: 'connected',
    payload: {
      message:      'Taskfire live updates connected',
      clients:      clients.size,
      connected_at: entry.connectedAt,
    },
  })

  void sendSnapshot(socket)

  // ── Incoming message handling ─────────────────────────────────────────────
  socket.on('message', (raw) => {
    let msg: unknown
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      sendTo(socket, {
        type: 'error',
        payload: { code: 'invalid_json', message: 'Message is not valid JSON' },
      })
      return
    }

    if (!isWsMessage(msg)) {
      sendTo(socket, {
        type: 'error',
        payload: { code: 'invalid_message', message: 'Message must have a "type" string field' },
      })
      return
    }

    switch (msg.type) {
      case 'ping':
        sendTo(socket, {
          type: 'pong',
          payload: { timestamp: new Date().toISOString() },
        })
        break

      case 'subscribe':
        // Reserved for future per-job-id subscription filtering.
        sendTo(socket, { type: 'subscribed', payload: { ok: true } })
        break

      default:
        sendTo(socket, {
          type: 'error',
          payload: { code: 'unknown_type', message: `Unknown message type "${msg.type}"` },
        })
    }
  })

  // ── Cleanup ───────────────────────────────────────────────────────────────
  socket.on('close', () => remove(socket))
  socket.on('error', () => remove(socket))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWsMessage(v: unknown): v is WsMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in v &&
    typeof (v as Record<string, unknown>)['type'] === 'string'
  )
}
