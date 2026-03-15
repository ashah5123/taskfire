import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { enqueueJob } from '../services/redis'
import { insertJob, getJobs, getJobById, updateJobStatus } from '../services/postgres'
import type { CreateJobDto } from '../types/job'

export async function jobRoutes(fastify: FastifyInstance) {
  // POST /api/jobs — create job
  fastify.post<{ Body: CreateJobDto }>('/', async (req, reply) => {
    const { type, payload = {}, priority = 0, max_retries = 3, scheduled_at, dependencies } = req.body

    if (!type) return reply.status(400).send({ error: 'type is required' })

    const job = {
      id: randomUUID(),
      type,
      payload,
      priority,
      max_retries,
      retry_count: 0,
      status: 'pending' as const,
      created_at: new Date().toISOString(),
      scheduled_at: scheduled_at ?? null,
      dependencies: dependencies ?? [],
    }

    await insertJob(job)
    await enqueueJob(job)

    reply.status(201).send(job)
  })

  // GET /api/jobs — list jobs
  fastify.get<{ Querystring: { status?: string; limit?: string; page?: string } }>(
    '/',
    async (req, reply) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      const page = Math.max(parseInt(req.query.page ?? '1', 10), 1)
      const offset = (page - 1) * limit

      const { rows, total } = await getJobs({ status: req.query.status, limit, offset })
      reply.send({ jobs: rows, total, page, limit })
    }
  )

  // GET /api/jobs/:id — get single job
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const job = await getJobById(req.params.id)
    if (!job) return reply.status(404).send({ error: 'job not found' })
    reply.send(job)
  })

  // DELETE /api/jobs/:id — cancel job
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const job = await getJobById(req.params.id)
    if (!job) return reply.status(404).send({ error: 'job not found' })
    if (job.status === 'active') return reply.status(409).send({ error: 'cannot cancel active job' })
    await updateJobStatus(req.params.id, 'failed', { failed_at: new Date().toISOString(), error: 'cancelled' })
    reply.status(204).send()
  })

  // POST /api/jobs/:id/retry — retry failed job
  fastify.post<{ Params: { id: string } }>('/:id/retry', async (req, reply) => {
    const job = await getJobById(req.params.id)
    if (!job) return reply.status(404).send({ error: 'job not found' })
    if (!['failed', 'dead'].includes(job.status)) {
      return reply.status(409).send({ error: 'only failed or dead jobs can be retried' })
    }
    const updated = { ...job, status: 'pending', retry_count: 0, error: null, failed_at: null }
    await updateJobStatus(job.id, 'pending', { retry_count: 0, error: null, failed_at: null })
    await enqueueJob(updated)
    reply.send(updated)
  })
}
