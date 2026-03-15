import { WebSocket } from 'ws'
import { FastifyRequest } from 'fastify'
import { getQueueDepth, getDLQDepth } from '../services/redis'
import { query } from '../services/postgres'

const clients = new Set<WebSocket>()

// Broadcast to all connected clients
export function broadcast(data: unknown) {
  const message = JSON.stringify(data)
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message)
    }
  }
}

// Push live metrics every 2 seconds
setInterval(async () => {
  if (clients.size === 0) return
  try {
    const [queueDepth, dlqDepth, activeRows] = await Promise.all([
      getQueueDepth(),
      getDLQDepth(),
      query<{ count: string }>(`SELECT COUNT(*) as count FROM jobs WHERE status = 'active'`),
    ])
    broadcast({
      type: 'metrics',
      payload: {
        queue_depth: queueDepth,
        dlq_depth: dlqDepth,
        active_jobs: parseInt(activeRows[0]?.count ?? '0', 10),
        timestamp: new Date().toISOString(),
      },
    })
  } catch {
    // Redis/Postgres may not be ready yet
  }
}, 2000)

export function wsHandler(socket: WebSocket, _req: FastifyRequest) {
  clients.add(socket)

  socket.send(JSON.stringify({ type: 'connected', payload: { message: 'Taskfire live updates connected' } }))

  socket.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }))
      }
    } catch {
      // ignore malformed messages
    }
  })

  socket.on('close', () => {
    clients.delete(socket)
  })

  socket.on('error', () => {
    clients.delete(socket)
  })
}
