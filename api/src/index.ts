import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { jobRoutes } from './routes/jobs'
import { metricsRoutes } from './routes/metrics'
import { wsHandler } from './websocket/handler'

const server = Fastify({ logger: true })

async function bootstrap() {
  await server.register(cors, { origin: process.env.CORS_ORIGIN || '*' })
  await server.register(websocket)

  server.register(jobRoutes, { prefix: '/api/jobs' })
  server.register(metricsRoutes, { prefix: '/api/metrics' })

  // WebSocket for real-time updates
  server.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, wsHandler)
  })

  server.get('/health', async () => ({ status: 'ok' }))

  const port = parseInt(process.env.PORT || '3001', 10)
  await server.listen({ port, host: '0.0.0.0' })
  console.log(`Taskfire API running on port ${port}`)
}

bootstrap().catch((err) => {
  console.error(err)
  process.exit(1)
})
