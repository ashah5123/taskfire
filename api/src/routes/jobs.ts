import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'crypto'
import { ZodError } from 'zod'
import {
  CreateJobSchema,
  ListJobsQuerySchema,
  JobIdParamSchema,
  RetryJobBodySchema,
  PRIORITY_VALUE,
} from '../types/job'
import {
  enqueueJob,
  enqueueDelayed,
  removeFromQueue,
} from '../services/redis'
import {
  insertJob,
  getJobs,
  getJobById,
  cancelJob,
  requeueJob,
  getJobLogs,
} from '../services/postgres'

function zodError(reply: FastifyReply, err: ZodError): FastifyReply {
  return reply.status(400).send({
    error: 'validation_error',
    message: 'Request validation failed',
    details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
  })
}

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST / — enqueue a new job ─────────────────────────────────────────────
  fastify.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateJobSchema.safeParse(req.body)
    if (!parsed.success) return zodError(reply, parsed.error)

    const { type, payload, priority, max_retries, scheduled_at, dependencies } = parsed.data
    const priorityValue = PRIORITY_VALUE[priority]
    const now = new Date()

    let job = await insertJob({
      id: randomUUID(),
      type,
      payload,
      priority: priorityValue,
      max_retries,
      scheduled_at: scheduled_at ?? null,
      dependencies,
    })

    const enqueuePayload = {
      id: job.id,
      type: job.type,
      payload: job.payload,
      priority: job.priority,
      status: 'pending',
      max_retries: job.max_retries,
      retry_count: 0,
      created_at: job.created_at,
      scheduled_at: job.scheduled_at ?? null,
      dependencies: job.dependencies,
    }

    if (scheduled_at && new Date(scheduled_at) > now) {
      await enqueueDelayed(enqueuePayload, new Date(scheduled_at))
    } else {
      await enqueueJob(enqueuePayload)
    }

    req.log.info({ job_id: job.id, job_type: type, priority }, 'job enqueued')
    return reply.status(201).send(job)
  })

  // ── GET / — list jobs with filters ────────────────────────────────────────
  fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ListJobsQuerySchema.safeParse(req.query)
    if (!parsed.success) return zodError(reply, parsed.error)

    const opts = parsed.data
    const { rows, total } = await getJobs(opts)
    const pages = Math.ceil(total / opts.limit)

    return reply.send({ jobs: rows, total, page: opts.page, limit: opts.limit, pages })
  })

  // ── GET /:id — get a single job ────────────────────────────────────────────
  fastify.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = JobIdParamSchema.safeParse(req.params)
    if (!parsed.success) return zodError(reply, parsed.error)

    const job = await getJobById(parsed.data.id)
    if (!job) return reply.status(404).send({ error: 'not_found', message: 'Job not found' })

    return reply.send(job)
  })

  // ── DELETE /:id — cancel a pending job ────────────────────────────────────
  fastify.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = JobIdParamSchema.safeParse(req.params)
    if (!parsed.success) return zodError(reply, parsed.error)

    const existing = await getJobById(parsed.data.id)
    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Job not found' })
    }
    if (existing.status === 'active') {
      return reply.status(409).send({
        error: 'conflict',
        message: 'Cannot cancel a job that is currently active',
      })
    }
    if (existing.status === 'completed') {
      return reply.status(409).send({
        error: 'conflict',
        message: 'Cannot cancel a job that has already completed',
      })
    }

    const cancelled = await cancelJob(parsed.data.id)
    if (!cancelled) {
      // Race condition: job moved to active between our check and the update.
      return reply.status(409).send({
        error: 'conflict',
        message: 'Job status changed before cancellation could be applied',
      })
    }

    // Best-effort removal from Redis priority lane; ignore if already dequeued.
    await removeFromQueue(existing.id, existing.priority).catch(() => undefined)

    req.log.info({ job_id: existing.id }, 'job cancelled')
    return reply.status(204).send()
  })

  // ── POST /:id/retry — manually retry a failed or dead job ─────────────────
  fastify.post('/:id/retry', async (req: FastifyRequest, reply: FastifyReply) => {
    const paramParsed = JobIdParamSchema.safeParse(req.params)
    if (!paramParsed.success) return zodError(reply, paramParsed.error)

    const bodyParsed = RetryJobBodySchema.safeParse(req.body ?? {})
    if (!bodyParsed.success) return zodError(reply, bodyParsed.error)

    const existing = await getJobById(paramParsed.data.id)
    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Job not found' })
    }
    if (!['failed', 'dead'].includes(existing.status)) {
      return reply.status(409).send({
        error: 'conflict',
        message: `Only failed or dead jobs can be retried; current status is "${existing.status}"`,
      })
    }

    const updated = await requeueJob(paramParsed.data.id, bodyParsed.data.reset_retries)
    if (!updated) {
      return reply.status(409).send({
        error: 'conflict',
        message: 'Job status changed before retry could be applied',
      })
    }

    await enqueueJob({
      id: updated.id,
      type: updated.type,
      payload: updated.payload,
      priority: updated.priority,
      status: 'pending',
      max_retries: updated.max_retries,
      retry_count: updated.retry_count,
      created_at: updated.created_at,
      scheduled_at: updated.scheduled_at ?? null,
      dependencies: updated.dependencies,
    })

    req.log.info({ job_id: updated.id, job_type: updated.type }, 'job manually retried')
    return reply.send(updated)
  })

  // ── GET /:id/logs — execution history for a job ───────────────────────────
  fastify.get('/:id/logs', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = JobIdParamSchema.safeParse(req.params)
    if (!parsed.success) return zodError(reply, parsed.error)

    const job = await getJobById(parsed.data.id)
    if (!job) return reply.status(404).send({ error: 'not_found', message: 'Job not found' })

    const logs = await getJobLogs(parsed.data.id)
    return reply.send({ job_id: job.id, job_type: job.type, logs })
  })
}
