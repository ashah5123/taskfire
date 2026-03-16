import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z, ZodError } from 'zod'
import {
  getQueueDepthByLane,
  getDLQDepth,
  getDLQJobs,
  getProcessingJobs,
} from '../services/redis'
import {
  getStatusCounts,
  getAvgProcessingMs,
  getThroughput,
  getActiveJobs,
} from '../services/postgres'

function zodError(reply: FastifyReply, err: ZodError): FastifyReply {
  return reply.status(400).send({
    error: 'validation_error',
    message: 'Request validation failed',
    details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
  })
}

const DLQQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /summary — queue depth, counts, failure rate, avg processing time ─
  fastify.get('/summary', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [queueDepth, dlqDepth, statusCounts, avgMs] = await Promise.all([
      getQueueDepthByLane(),
      getDLQDepth(),
      getStatusCounts(),
      getAvgProcessingMs(),
    ])

    const total = statusCounts.completed + statusCounts.failed + statusCounts.dead
    const failureRate = total > 0
      ? (statusCounts.failed + statusCounts.dead) / total
      : 0

    return reply.send({
      queue_depth: queueDepth,
      dlq_depth: dlqDepth,
      counts: {
        pending: statusCounts.pending,
        active: statusCounts.active,
        completed: statusCounts.completed,
        failed: statusCounts.failed,
        dead: statusCounts.dead,
        total_processed: total,
      },
      failure_rate: parseFloat(failureRate.toFixed(4)),
      avg_processing_ms: avgMs,
    })
  })

  // ── GET /throughput — jobs/minute over last 60 minutes ────────────────────
  fastify.get('/throughput', async (_req: FastifyRequest, reply: FastifyReply) => {
    const rows = await getThroughput()

    // Fill in any missing minutes in the last hour with zero so the dashboard
    // can render a contiguous time-series without gaps.
    const byMinute = new Map(rows.map((r) => [r.time, r]))
    const now = new Date()
    const points = []

    for (let i = 59; i >= 0; i--) {
      const t = new Date(now)
      t.setSeconds(0, 0)
      t.setMinutes(t.getMinutes() - i)
      const key = t.toISOString()
      const existing = byMinute.get(key)
      points.push({
        time: key,
        completed: existing?.completed ?? 0,
        failed: existing?.failed ?? 0,
      })
    }

    return reply.send(points)
  })

  // ── GET /workers — active workers, utilization, in-flight jobs ────────────
  fastify.get('/workers', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [activeDbJobs, processingRedis] = await Promise.all([
      getActiveJobs(),
      getProcessingJobs(),
    ])

    const now = Date.now()

    const activeJobs = activeDbJobs.map((row) => ({
      job_id: row.id,
      job_type: row.type,
      started_at: row.started_at.toISOString(),
      running_for_ms: now - row.started_at.getTime(),
    }))

    // Cross-reference Postgres active jobs with Redis processing hash so that
    // the response reflects the same set even if the two stores have brief lag.
    const processingIds = new Set(
      processingRedis.map((j) => j.id as string).filter(Boolean)
    )

    return reply.send({
      active_workers: activeJobs.length,
      in_flight_redis: processingRedis.length,
      discrepancy: Math.abs(activeJobs.length - processingRedis.length),
      active_jobs: activeJobs,
      processing_ids_redis: [...processingIds],
    })
  })

  // ── GET /dead-letter — list DLQ entries with failure details ─────────────
  fastify.get('/dead-letter', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = DLQQuerySchema.safeParse(req.query)
    if (!parsed.success) return zodError(reply, parsed.error)

    const { limit, offset } = parsed.data
    const [jobs, total] = await Promise.all([
      getDLQJobs(limit, offset),
      getDLQDepth(),
    ])

    return reply.send({
      jobs,
      total,
      limit,
      offset,
    })
  })
}
