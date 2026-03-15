import { FastifyInstance } from 'fastify'
import { getQueueDepth, getDLQDepth, getRecentCompleted } from '../services/redis'
import { query } from '../services/postgres'

export async function metricsRoutes(fastify: FastifyInstance) {
  // GET /api/metrics/overview
  fastify.get('/overview', async (_req, reply) => {
    const [queueDepth, dlqDepth, completed] = await Promise.all([
      getQueueDepth(),
      getDLQDepth(),
      getRecentCompleted(1000),
    ])

    const completedJobs = completed.map((s) => {
      try { return JSON.parse(s) } catch { return null }
    }).filter(Boolean)

    const [statusCounts] = await Promise.all([
      query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) as count FROM jobs GROUP BY status`
      ),
    ])

    const byStatus = Object.fromEntries(statusCounts.map((r) => [r.status, parseInt(r.count, 10)]))

    reply.send({
      queue_depth: queueDepth,
      dlq_depth: dlqDepth,
      by_status: byStatus,
      completed_last_1k: completedJobs.length,
    })
  })

  // GET /api/metrics/throughput — jobs/minute over last hour
  fastify.get('/throughput', async (_req, reply) => {
    const rows = await query<{ minute: string; count: string }>(
      `SELECT date_trunc('minute', completed_at) as minute, COUNT(*) as count
       FROM jobs
       WHERE completed_at > NOW() - INTERVAL '1 hour'
       GROUP BY 1
       ORDER BY 1`
    )
    reply.send(rows.map((r) => ({ time: r.minute, count: parseInt(r.count, 10) })))
  })

  // GET /api/metrics/failure-rate — failure rate over last hour
  fastify.get('/failure-rate', async (_req, reply) => {
    const rows = await query<{ minute: string; total: string; failed: string }>(
      `SELECT date_trunc('minute', created_at) as minute,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM jobs
       WHERE created_at > NOW() - INTERVAL '1 hour'
       GROUP BY 1
       ORDER BY 1`
    )
    reply.send(
      rows.map((r) => ({
        time: r.minute,
        total: parseInt(r.total, 10),
        failed: parseInt(r.failed, 10),
        rate: parseInt(r.total, 10) > 0 ? parseInt(r.failed, 10) / parseInt(r.total, 10) : 0,
      }))
    )
  })
}
