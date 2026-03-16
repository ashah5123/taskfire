import supertest from 'supertest'
import { FastifyInstance } from 'fastify'
import { buildApp } from './helpers/app'

// ── Mock service modules ──────────────────────────────────────────────────────

jest.mock('../services/redis', () => ({
  enqueueJob: jest.fn().mockResolvedValue(undefined),
  enqueueDelayed: jest.fn().mockResolvedValue(undefined),
  removeFromQueue: jest.fn().mockResolvedValue(undefined),
  getQueueDepthByLane: jest.fn(),
  getDLQDepth: jest.fn(),
  getDLQJobs: jest.fn(),
  getProcessingJobs: jest.fn(),
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

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Metrics Routes', () => {
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

  // ── GET /summary ─────────────────────────────────────────────────────────────

  describe('GET /api/metrics/summary', () => {
    it('returns summary with computed failure rate', async () => {
      redis.getQueueDepthByLane.mockResolvedValue({ high: 2, medium: 5, low: 1 })
      redis.getDLQDepth.mockResolvedValue(3)
      postgres.getStatusCounts.mockResolvedValue({
        pending: 8, active: 2, completed: 90, failed: 7, dead: 3,
      })
      postgres.getAvgProcessingMs.mockResolvedValue(54)

      const res = await supertest(app.server)
        .get('/api/metrics/summary')
        .expect(200)

      expect(res.body.queue_depth).toEqual({ high: 2, medium: 5, low: 1 })
      expect(res.body.dlq_depth).toBe(3)
      expect(res.body.counts.completed).toBe(90)
      expect(res.body.counts.total_processed).toBe(100)
      expect(res.body.failure_rate).toBeCloseTo(0.1, 4)
      expect(res.body.avg_processing_ms).toBe(54)
    })

    it('returns zero failure rate when no jobs processed', async () => {
      redis.getQueueDepthByLane.mockResolvedValue({ high: 0, medium: 0, low: 0 })
      redis.getDLQDepth.mockResolvedValue(0)
      postgres.getStatusCounts.mockResolvedValue({
        pending: 0, active: 0, completed: 0, failed: 0, dead: 0,
      })
      postgres.getAvgProcessingMs.mockResolvedValue(null)

      const res = await supertest(app.server)
        .get('/api/metrics/summary')
        .expect(200)

      expect(res.body.failure_rate).toBe(0)
    })
  })

  // ── GET /throughput ──────────────────────────────────────────────────────────

  describe('GET /api/metrics/throughput', () => {
    it('returns 60 data points with zero-fill for missing minutes', async () => {
      postgres.getThroughput.mockResolvedValue([])

      const res = await supertest(app.server)
        .get('/api/metrics/throughput')
        .expect(200)

      expect(res.body).toHaveLength(60)
      for (const point of res.body) {
        expect(point).toHaveProperty('time')
        expect(point.completed).toBe(0)
        expect(point.failed).toBe(0)
      }
    })

    it('fills in known throughput values', async () => {
      const now = new Date()
      now.setSeconds(0, 0)
      const key = now.toISOString()

      postgres.getThroughput.mockResolvedValue([
        { time: key, completed: 12, failed: 1 },
      ])

      const res = await supertest(app.server)
        .get('/api/metrics/throughput')
        .expect(200)

      expect(res.body).toHaveLength(60)
      const match = res.body.find((p: { time: string }) => p.time === key)
      expect(match?.completed).toBe(12)
      expect(match?.failed).toBe(1)
    })
  })

  // ── GET /workers ──────────────────────────────────────────────────────────────

  describe('GET /api/metrics/workers', () => {
    it('returns worker utilization data', async () => {
      const startedAt = new Date()
      postgres.getActiveJobs.mockResolvedValue([
        { id: 'job-1', type: 'email', started_at: startedAt },
      ])
      redis.getProcessingJobs.mockResolvedValue([{ id: 'job-1' }])

      const res = await supertest(app.server)
        .get('/api/metrics/workers')
        .expect(200)

      expect(res.body.active_workers).toBe(1)
      expect(res.body.in_flight_redis).toBe(1)
      expect(res.body.active_jobs).toHaveLength(1)
      expect(res.body.active_jobs[0].job_id).toBe('job-1')
    })

    it('reports discrepancy when counts differ', async () => {
      postgres.getActiveJobs.mockResolvedValue([
        { id: 'job-1', type: 'noop', started_at: new Date() },
        { id: 'job-2', type: 'noop', started_at: new Date() },
      ])
      redis.getProcessingJobs.mockResolvedValue([{ id: 'job-1' }])

      const res = await supertest(app.server)
        .get('/api/metrics/workers')
        .expect(200)

      expect(res.body.discrepancy).toBe(1)
    })

    it('returns empty state when no active workers', async () => {
      postgres.getActiveJobs.mockResolvedValue([])
      redis.getProcessingJobs.mockResolvedValue([])

      const res = await supertest(app.server)
        .get('/api/metrics/workers')
        .expect(200)

      expect(res.body.active_workers).toBe(0)
      expect(res.body.active_jobs).toHaveLength(0)
    })
  })

  // ── GET /dead-letter ──────────────────────────────────────────────────────────

  describe('GET /api/metrics/dead-letter', () => {
    it('returns DLQ entries with pagination metadata', async () => {
      const deadJob = { id: 'dead-1', type: 'email', error_message: 'boom' }
      redis.getDLQJobs.mockResolvedValue([deadJob])
      redis.getDLQDepth.mockResolvedValue(1)

      const res = await supertest(app.server)
        .get('/api/metrics/dead-letter')
        .expect(200)

      expect(res.body.jobs).toHaveLength(1)
      expect(res.body.total).toBe(1)
      expect(res.body).toHaveProperty('limit')
      expect(res.body).toHaveProperty('offset')
    })

    it('applies limit and offset query params', async () => {
      redis.getDLQJobs.mockResolvedValue([])
      redis.getDLQDepth.mockResolvedValue(0)

      await supertest(app.server)
        .get('/api/metrics/dead-letter?limit=10&offset=20')
        .expect(200)

      expect(redis.getDLQJobs).toHaveBeenCalledWith(10, 20)
    })

    it('returns 400 for invalid limit', async () => {
      const res = await supertest(app.server)
        .get('/api/metrics/dead-letter?limit=0')
        .expect(400)

      expect(res.body.error).toBe('validation_error')
    })
  })
})
