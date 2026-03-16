import { createClient, RedisClientType } from 'redis'
import type { DLQEntry, JobPriority, QueueDepthByLane } from '../types/job'
import { priorityLabel } from '../types/job'

// ── Client management ─────────────────────────────────────────────────────────

let client: RedisClientType
let subscriber: RedisClientType

const REDIS_URL = () => process.env.REDIS_URL ?? 'redis://localhost:6379'

// Redis key constants — must match the Go worker's constants exactly.
const KEY_QUEUE_HIGH = 'taskfire:queue:high'
const KEY_QUEUE_MEDIUM = 'taskfire:queue:medium'
const KEY_QUEUE_LOW = 'taskfire:queue:low'
const KEY_DELAYED = 'taskfire:delayed'
const KEY_PROCESSING = 'taskfire:processing'
const KEY_DLQ = 'taskfire:dlq'
const KEY_DONE = 'taskfire:done'
const KEY_EVENTS = 'taskfire:events'

function laneKey(priority: number): string {
  if (priority >= 300) return KEY_QUEUE_HIGH
  if (priority >= 200) return KEY_QUEUE_MEDIUM
  return KEY_QUEUE_LOW
}

export async function getRedisClient(): Promise<RedisClientType> {
  if (client?.isOpen) return client
  client = createClient({ url: REDIS_URL() }) as RedisClientType
  client.on('error', (err: Error) => {
    // Errors are logged at the server level via the error event; suppress
    // unhandled-rejection noise here.
    void err
  })
  await client.connect()
  return client
}

export async function getSubscriberClient(): Promise<RedisClientType> {
  if (subscriber?.isOpen) return subscriber
  subscriber = createClient({ url: REDIS_URL() }) as RedisClientType
  subscriber.on('error', (err: Error) => { void err })
  await subscriber.connect()
  return subscriber
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    client?.isOpen ? client.quit() : Promise.resolve(),
    subscriber?.isOpen ? subscriber.quit() : Promise.resolve(),
  ])
}

// ── Connection with retry ─────────────────────────────────────────────────────

export async function connectRedisWithRetry(maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await getRedisClient()
      return
    } catch (err) {
      if (attempt === maxAttempts) throw err
      const wait = attempt * 2000
      await new Promise((res) => setTimeout(res, wait))
    }
  }
}

// ── Enqueueing ────────────────────────────────────────────────────────────────

export interface EnqueuePayload {
  id: string
  type: string
  payload: Record<string, unknown>
  priority: number
  status: string
  max_retries: number
  retry_count: number
  created_at: string
  scheduled_at?: string | null
  dependencies?: string[]
  [key: string]: unknown
}

export async function enqueueJob(job: EnqueuePayload): Promise<void> {
  const redis = await getRedisClient()
  const score = Date.now() // unix millis — FIFO within lane, matches Go worker
  const key = laneKey(job.priority)
  await redis.zAdd(key, { score, value: JSON.stringify(job) })
}

export async function enqueueDelayed(job: EnqueuePayload, scheduledAt: Date): Promise<void> {
  const redis = await getRedisClient()
  const score = Math.floor(scheduledAt.getTime() / 1000) // unix seconds, matches Go worker
  const jobWithSchedule = { ...job, scheduled_at: scheduledAt.toISOString(), status: 'pending' }
  await redis.zAdd(KEY_DELAYED, { score, value: JSON.stringify(jobWithSchedule) })
}

// ── Queue depth ───────────────────────────────────────────────────────────────

export async function getQueueDepthByLane(): Promise<QueueDepthByLane> {
  const redis = await getRedisClient()
  const [high, medium, low, delayed] = await Promise.all([
    redis.zCard(KEY_QUEUE_HIGH),
    redis.zCard(KEY_QUEUE_MEDIUM),
    redis.zCard(KEY_QUEUE_LOW),
    redis.zCard(KEY_DELAYED),
  ])
  return { high, medium, low, delayed, total: high + medium + low }
}

export async function getQueueDepth(): Promise<number> {
  const depth = await getQueueDepthByLane()
  return depth.total
}

export async function getDLQDepth(): Promise<number> {
  const redis = await getRedisClient()
  return redis.zCard(KEY_DLQ)
}

// ── DLQ ───────────────────────────────────────────────────────────────────────

export async function getDLQJobs(limit = 100, offset = 0): Promise<DLQEntry[]> {
  const redis = await getRedisClient()
  // DLQ is a sorted set scored by failure unix-nano timestamp (ascending = oldest first).
  const raw = await redis.zRange(KEY_DLQ, offset, offset + limit - 1, { REV: true })
  return raw.flatMap((s) => {
    try {
      const job = JSON.parse(s) as Record<string, unknown>
      return [{
        id: job.id as string,
        type: job.type as string,
        payload: (job.payload ?? {}) as Record<string, unknown>,
        priority: Number(job.priority ?? 100),
        priority_label: priorityLabel(Number(job.priority ?? 100)) as JobPriority,
        error: (job.error_message as string | null) ?? null,
        retry_count: Number(job.retry_count ?? 0),
        max_retries: Number(job.max_retries ?? 3),
        failed_at: (job.failed_at as string | null) ?? null,
        created_at: job.created_at as string,
      } satisfies DLQEntry]
    } catch {
      return []
    }
  })
}

// ── Processing (in-flight) jobs ───────────────────────────────────────────────

export async function getProcessingJobs(): Promise<Record<string, unknown>[]> {
  const redis = await getRedisClient()
  const hash = await redis.hGetAll(KEY_PROCESSING)
  return Object.values(hash).flatMap((s) => {
    try { return [JSON.parse(s) as Record<string, unknown>] } catch { return [] }
  })
}

// ── Completed list ────────────────────────────────────────────────────────────

export async function getRecentCompleted(limit = 100): Promise<string[]> {
  const redis = await getRedisClient()
  return redis.lRange(KEY_DONE, 0, limit - 1)
}

// ── Remove a specific job from its priority queue (for cancellation) ──────────

export async function removeFromQueue(jobId: string, priority: number): Promise<boolean> {
  const redis = await getRedisClient()
  const key = laneKey(priority)
  // We need to scan for the job JSON containing this ID since the value is the full job JSON.
  // Use ZSCAN to find the exact member efficiently.
  let cursor = 0
  do {
    const result = await redis.zScan(key, cursor, { MATCH: `*"id":"${jobId}"*`, COUNT: 100 })
    cursor = result.cursor
    for (const { value } of result.members) {
      try {
        const parsed = JSON.parse(value) as { id?: string }
        if (parsed.id === jobId) {
          await redis.zRem(key, value)
          return true
        }
      } catch { /* skip malformed */ }
    }
  } while (cursor !== 0)
  return false
}

// ── Pub/Sub ───────────────────────────────────────────────────────────────────

export async function subscribeToEvents(
  onMessage: (message: string) => void
): Promise<() => Promise<void>> {
  const sub = await getSubscriberClient()
  await sub.subscribe(KEY_EVENTS, onMessage)
  return async () => {
    await sub.unsubscribe(KEY_EVENTS)
  }
}
