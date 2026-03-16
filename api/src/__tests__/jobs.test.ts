import supertest from 'supertest'
import { FastifyInstance } from 'fastify'
import { buildApp } from './helpers/app'

// ── Mock service modules ──────────────────────────────────────────────────────

jest.mock('../services/redis', () => ({
  enqueueJob: jest.fn().mockResolvedValue(undefined),
  enqueueDelayed: jest.fn().mockResolvedValue(undefined),
  removeFromQueue: jest.fn().mockResolvedValue(undefined),
  getQueueDepthByLane: jest.fn().mockResolvedValue({ high: 0, medium: 0, low: 0 }),
  getDLQDepth: jest.fn().mockResolvedValue(0),
  getDLQJobs: jest.fn().mockResolvedValue([]),
  getProcessingJobs: jest.fn().mockResolvedValue([]),
}))

jest.mock('../services/postgres', () => ({
  insertJob: jest.fn(),
  getJobs: jest.fn(),
  getJobById: jest.fn(),
  cancelJob: jest.fn(),
  requeueJob: jest.fn(),
  getJobLogs: jest.fn(),
  getStatusCounts: jest.fn(),
  getAvgProcessingMs: jest.fn(),
  getThroughput: jest.fn(),
  getActiveJobs: jest.fn(),
}))

// ── Shared fixtures ───────────────────────────────────────────────────────────

const mockJob = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  type: 'noop',
  payload: {},
  priority: 200,
  status: 'pending',
  retry_count: 0,
  max_retries: 3,
  error: null,
  dependencies: [],
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-01T00:00:00Z'),
  scheduled_at: null,
  started_at: null,
  completed_at: null,
  failed_at: null,
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Job Routes', () => {
  let app: FastifyInstance
  let postgres: Record<string, jest.Mock>
  let redis: Record<string, jest.Mock>

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    postgres = jest.requireMock('../services/postgres')
    redis = jest.requireMock('../services/redis')
  })

  // ── POST / ──────────────────────────────────────────────────────────────────

  describe('POST /api/jobs', () => {
    it('creates a job and returns 201', async () => {
      postgres.insertJob.mockResolvedValue(mockJob)

      const res = await supertest(app.server)
        .post('/api/jobs')
        .send({ type: 'noop', payload: {}, priority: 'medium' })
        .expect(201)

      expect(res.body.id).toBe(mockJob.id)
      expect(postgres.insertJob).toHaveBeenCalledTimes(1)
      expect(redis.enqueueJob).toHaveBeenCalledTimes(1)
    })

    it('returns 400 for missing type', async () => {
      const res = await supertest(app.server)
        .post('/api/jobs')
        .send({ payload: {} })
        .expect(400)

      expect(res.body.error).toBe('validation_error')
    })

    it('calls enqueueDelayed for future scheduled_at', async () => {
      const future = new Date(Date.now() + 60_000).toISOString()
      postgres.insertJob.mockResolvedValue({ ...mockJob, scheduled_at: future })

      await supertest(app.server)
        .post('/api/jobs')
        .send({ type: 'noop', payload: {}, priority: 'low', scheduled_at: future })
        .expect(201)

      expect(redis.enqueueDelayed).toHaveBeenCalledTimes(1)
      expect(redis.enqueueJob).not.toHaveBeenCalled()
    })
  })

  // ── GET / ───────────────────────────────────────────────────────────────────

  describe('GET /api/jobs', () => {
    it('returns job list with pagination', async () => {
      postgres.getJobs.mockResolvedValue({ rows: [mockJob], total: 1 })

      const res = await supertest(app.server)
        .get('/api/jobs')
        .expect(200)

      expect(res.body.jobs).toHaveLength(1)
      expect(res.body.total).toBe(1)
      expect(res.body).toHaveProperty('pages')
    })

    it('returns 400 for invalid query params', async () => {
      const res = await supertest(app.server)
        .get('/api/jobs?limit=notanumber')
        .expect(400)

      expect(res.body.error).toBe('validation_error')
    })
  })

  // ── GET /:id ─────────────────────────────────────────────────────────────────

  describe('GET /api/jobs/:id', () => {
    it('returns the job when found', async () => {
      postgres.getJobById.mockResolvedValue(mockJob)

      const res = await supertest(app.server)
        .get(`/api/jobs/${mockJob.id}`)
        .expect(200)

      expect(res.body.id).toBe(mockJob.id)
    })

    it('returns 404 when job not found', async () => {
      postgres.getJobById.mockResolvedValue(null)

      const res = await supertest(app.server)
        .get('/api/jobs/aaaaaaaa-aaaa-aaaa-aaaa-000000000000')
        .expect(404)

      expect(res.body.error).toBe('not_found')
    })

    it('returns 400 for invalid UUID', async () => {
      await supertest(app.server)
        .get('/api/jobs/not-a-uuid')
        .expect(400)
    })
  })

  // ── DELETE /:id ───────────────────────────────────────────────────────────────

  describe('DELETE /api/jobs/:id', () => {
    it('cancels a pending job and returns 204', async () => {
      postgres.getJobById.mockResolvedValue({ ...mockJob, status: 'pending' })
      postgres.cancelJob.mockResolvedValue({ ...mockJob, status: 'failed' })

      await supertest(app.server)
        .delete(`/api/jobs/${mockJob.id}`)
        .expect(204)

      expect(postgres.cancelJob).toHaveBeenCalledWith(mockJob.id)
    })

    it('returns 409 when job is active', async () => {
      postgres.getJobById.mockResolvedValue({ ...mockJob, status: 'active' })

      const res = await supertest(app.server)
        .delete(`/api/jobs/${mockJob.id}`)
        .expect(409)

      expect(res.body.error).toBe('conflict')
    })

    it('returns 409 when job is completed', async () => {
      postgres.getJobById.mockResolvedValue({ ...mockJob, status: 'completed' })

      const res = await supertest(app.server)
        .delete(`/api/jobs/${mockJob.id}`)
        .expect(409)

      expect(res.body.error).toBe('conflict')
    })

    it('returns 404 when job not found', async () => {
      postgres.getJobById.mockResolvedValue(null)

      await supertest(app.server)
        .delete(`/api/jobs/${mockJob.id}`)
        .expect(404)
    })

    it('returns 409 when cancelJob returns null (race condition)', async () => {
      postgres.getJobById.mockResolvedValue({ ...mockJob, status: 'pending' })
      postgres.cancelJob.mockResolvedValue(null)

      await supertest(app.server)
        .delete(`/api/jobs/${mockJob.id}`)
        .expect(409)
    })
  })

  // ── POST /:id/retry ───────────────────────────────────────────────────────────

  describe('POST /api/jobs/:id/retry', () => {
    it('retries a failed job and returns 200', async () => {
      const failedJob = { ...mockJob, status: 'failed' }
      postgres.getJobById.mockResolvedValue(failedJob)
      postgres.requeueJob.mockResolvedValue({ ...mockJob, status: 'pending' })

      const res = await supertest(app.server)
        .post(`/api/jobs/${mockJob.id}/retry`)
        .send({})
        .expect(200)

      expect(res.body.status).toBe('pending')
      expect(redis.enqueueJob).toHaveBeenCalledTimes(1)
    })

    it('retries a dead job and returns 200', async () => {
      postgres.getJobById.mockResolvedValue({ ...mockJob, status: 'dead' })
      postgres.requeueJob.mockResolvedValue({ ...mockJob, status: 'pending' })

      await supertest(app.server)
        .post(`/api/jobs/${mockJob.id}/retry`)
        .send({})
        .expect(200)
    })

    it('returns 409 for a pending job', async () => {
      postgres.getJobById.mockResolvedValue({ ...mockJob, status: 'pending' })

      const res = await supertest(app.server)
        .post(`/api/jobs/${mockJob.id}/retry`)
        .send({})
        .expect(409)

      expect(res.body.error).toBe('conflict')
    })

    it('returns 404 when job not found', async () => {
      postgres.getJobById.mockResolvedValue(null)

      await supertest(app.server)
        .post(`/api/jobs/${mockJob.id}/retry`)
        .send({})
        .expect(404)
    })
  })

  // ── GET /:id/logs ─────────────────────────────────────────────────────────────

  describe('GET /api/jobs/:id/logs', () => {
    it('returns logs for a job', async () => {
      postgres.getJobById.mockResolvedValue(mockJob)
      postgres.getJobLogs.mockResolvedValue([
        { id: 1, job_id: mockJob.id, level: 'info', message: 'started', metadata: null, created_at: new Date() },
      ])

      const res = await supertest(app.server)
        .get(`/api/jobs/${mockJob.id}/logs`)
        .expect(200)

      expect(res.body.job_id).toBe(mockJob.id)
      expect(res.body.logs).toHaveLength(1)
    })

    it('returns 404 when job not found', async () => {
      postgres.getJobById.mockResolvedValue(null)

      await supertest(app.server)
        .get(`/api/jobs/${mockJob.id}/logs`)
        .expect(404)
    })
  })
})
