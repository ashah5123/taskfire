import Fastify, { FastifyInstance } from 'fastify'
import { jobRoutes } from '../../routes/jobs'
import { metricsRoutes } from '../../routes/metrics'

/**
 * Build a minimal Fastify instance with only the job and metrics routes
 * registered — no real Redis/Postgres connections, no middleware. Service
 * calls are intercepted by jest.mock() in each test file.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.register(metricsRoutes, { prefix: '/api/metrics' })

  await app.ready()
  return app
}
