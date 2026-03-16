import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { jobRoutes } from './routes/jobs'
import { metricsRoutes } from './routes/metrics'
import {
  wsHandler,
  startEventForwarding,
  stopEventForwarding,
  startMetricsBroadcast,
  stopMetricsBroadcast,
  startHeartbeat,
  stopHeartbeat,
} from './websocket/handler'
import { connectRedisWithRetry, closeRedis } from './services/redis'
import { connectPostgresWithRetry, closePostgres } from './services/postgres'

const server: FastifyInstance = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(process.env.NODE_ENV !== 'production'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  },
})

async function bootstrap(): Promise<void> {
  // ── Security & middleware ─────────────────────────────────────────────────
  await server.register(helmet, {
    contentSecurityPolicy: false, // CSP is handled at the Nginx layer
  })

  await server.register(cors, {
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  await server.register(rateLimit, {
    global: true,
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '200', 10),
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      error: 'rate_limit_exceeded',
      message: `Too many requests — limit is ${context.max} per ${context.after}`,
      statusCode: 429,
    }),
  })

  // ── WebSocket ─────────────────────────────────────────────────────────────
  await server.register(websocket)

  // ── Routes ────────────────────────────────────────────────────────────────
  await server.register(jobRoutes, { prefix: '/api/jobs' })
  await server.register(metricsRoutes, { prefix: '/api/metrics' })

  await server.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, wsHandler)
  })

  // ── Health ────────────────────────────────────────────────────────────────
  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_s: Math.floor(process.uptime()),
  }))

  server.get('/ready', async (_req, reply) => {
    // Shallow ping — returns 200 only when both backing stores are reachable.
    try {
      await Promise.all([connectRedisWithRetry(1), connectPostgresWithRetry(1)])
      return reply.send({ ready: true })
    } catch {
      return reply.status(503).send({ ready: false })
    }
  })

  // ── Global error handler ──────────────────────────────────────────────────
  server.setErrorHandler((err, req, reply) => {
    const statusCode = err.statusCode ?? 500
    req.log.error(
      { err, method: req.method, url: req.url, status: statusCode },
      'request error'
    )
    if (statusCode >= 500) {
      return reply.status(500).send({ error: 'internal_server_error', message: 'An unexpected error occurred' })
    }
    return reply.status(statusCode).send({ error: err.code ?? 'error', message: err.message })
  })

  server.setNotFoundHandler((req, reply) => {
    return reply.status(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url} not found` })
  })

  // ── Backing store connections ─────────────────────────────────────────────
  server.log.info('connecting to Redis...')
  await connectRedisWithRetry()
  server.log.info('Redis connected')

  server.log.info('connecting to Postgres...')
  await connectPostgresWithRetry()
  server.log.info('Postgres connected')

  // ── Real-time infrastructure ──────────────────────────────────────────────
  await startEventForwarding()
  startMetricsBroadcast()
  startHeartbeat()

  // ── Listen ────────────────────────────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? '3001', 10)
  const host = process.env.HOST ?? '0.0.0.0'
  await server.listen({ port, host })
  server.log.info({ port, host }, 'Taskfire API listening')
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  server.log.info({ signal }, 'shutdown signal received')
  try {
    stopHeartbeat()
    stopMetricsBroadcast()
    await stopEventForwarding()
    await server.close()
    await closeRedis()
    await closePostgres()
    server.log.info('shutdown complete')
    process.exit(0)
  } catch (err) {
    server.log.error({ err }, 'error during shutdown')
    process.exit(1)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  server.log.error({ err }, 'uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  server.log.error({ reason }, 'unhandled promise rejection')
  process.exit(1)
})

bootstrap().catch((err) => {
  console.error('failed to start server:', err)
  process.exit(1)
})
