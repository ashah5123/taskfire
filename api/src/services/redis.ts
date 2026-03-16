import IORedis, { Redis, ChainableCommander } from 'ioredis'
import type { DLQEntry, JobPriority, QueueDepthByLane } from '../types/job'
import { priorityLabel } from '../types/job'

// ── Redis key constants — must match the Go worker exactly ────────────────────

const KEY_QUEUE_HIGH   = 'taskfire:queue:high'
const KEY_QUEUE_MEDIUM = 'taskfire:queue:medium'
const KEY_QUEUE_LOW    = 'taskfire:queue:low'
const KEY_DELAYED      = 'taskfire:delayed'
const KEY_PROCESSING   = 'taskfire:processing'
const KEY_DLQ          = 'taskfire:dlq'
const KEY_DONE         = 'taskfire:done'
export const KEY_EVENTS = 'taskfire:events'

// ── Client factory ────────────────────────────────────────────────────────────

function buildClient(lazyConnect = true): Redis {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const client = new IORedis(url, {
    lazyConnect,
    // How many times to retry a failed command before rejecting.
    maxRetriesPerRequest: 3,
    // Reconnect with exponential backoff capped at 2 s; give up after 20 tries.
    retryStrategy(times: number): number | null {
      if (times > 20) return null
      return Math.min(times * 150, 2000)
    },
    // Re-establish the connection on READONLY errors (Sentinel failover).
    reconnectOnError(err: Error): boolean {
      return err.message.includes('READONLY')
    },
    enableOfflineQueue: true,
  })

  client.on('error', (_err: Error) => {
    // Suppress unhandled-rejection noise; callers surface errors through
    // rejected promises on the commands that fail.
  })

  return client
}

// ── Singleton clients ─────────────────────────────────────────────────────────

let _client: Redis | null = null
let _subscriber: Redis | null = null

function getClient(): Redis {
  if (!_client) _client = buildClient(true)
  return _client
}

function getSubscriber(): Redis {
  if (!_subscriber) _subscriber = buildClient(true)
  return _subscriber
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function connectRedisWithRetry(maxAttempts = 5): Promise<void> {
  const client = getClient()
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (client.status !== 'ready') await client.connect()
      await client.ping()
      return
    } catch (err) {
      if (attempt === maxAttempts) throw err
      await new Promise<void>((res) => setTimeout(res, attempt * 2_000))
    }
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    _client ? _client.quit() : Promise.resolve(),
    _subscriber ? _subscriber.quit() : Promise.resolve(),
  ])
  _client = null
  _subscriber = null
}

// ── EnqueuePayload — mirrors the Go worker's Job struct ───────────────────────

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

// ── Priority lane routing ─────────────────────────────────────────────────────

function laneKey(priority: number): string {
  if (priority >= 300) return KEY_QUEUE_HIGH
  if (priority >= 200) return KEY_QUEUE_MEDIUM
  return KEY_QUEUE_LOW
}

// ── Enqueueing ────────────────────────────────────────────────────────────────

/**
 * Enqueue a job into the correct priority lane sorted set.
 * Score = unix milliseconds for FIFO ordering within the lane — matches the
 * Go worker which uses time.Now().UnixMilli() as the ZADD score.
 */
export async function enqueueJob(job: EnqueuePayload): Promise<void> {
  const score = Date.now()
  const key = laneKey(job.priority)
  await getClient().zadd(key, score, JSON.stringify(job))
}

/**
 * Enqueue a job into the delayed sorted set, scored by scheduledAt unix
 * seconds so the Go worker's DrainDelayed Lua script can promote it to
 * the right priority lane at the right time.
 */
export async function enqueueDelayed(
  job: EnqueuePayload,
  scheduledAt: Date
): Promise<void> {
  const score = Math.floor(scheduledAt.getTime() / 1_000)
  const data = JSON.stringify({ ...job, scheduled_at: scheduledAt.toISOString(), status: 'pending' })
  await getClient().zadd(KEY_DELAYED, score, data)
}

// ── Queue depth ───────────────────────────────────────────────────────────────

export async function getQueueDepthByLane(): Promise<QueueDepthByLane> {
  const pipeline = getClient().pipeline()
  pipeline.zcard(KEY_QUEUE_HIGH)
  pipeline.zcard(KEY_QUEUE_MEDIUM)
  pipeline.zcard(KEY_QUEUE_LOW)
  pipeline.zcard(KEY_DELAYED)

  const results = await (pipeline as ChainableCommander).exec()
  if (!results) return { high: 0, medium: 0, low: 0, delayed: 0, total: 0 }

  const val = (i: number): number => {
    const entry = results[i]
    return entry && entry[0] === null ? (entry[1] as number) : 0
  }

  const high = val(0)
  const medium = val(1)
  const low = val(2)
  const delayed = val(3)
  return { high, medium, low, delayed, total: high + medium + low }
}

export async function getQueueDepth(): Promise<number> {
  const d = await getQueueDepthByLane()
  return d.total
}

export async function getDLQDepth(): Promise<number> {
  return getClient().zcard(KEY_DLQ)
}

// ── DLQ ───────────────────────────────────────────────────────────────────────

/**
 * Return DLQ entries newest-first (highest unix-nano score = most recent failure).
 * Uses ZREVRANGE so the caller gets chronologically descending results.
 */
export async function getDLQJobs(limit = 100, offset = 0): Promise<DLQEntry[]> {
  const raw = await getClient().zrevrange(KEY_DLQ, offset, offset + limit - 1)
  return raw.flatMap((s) => {
    try {
      const job = JSON.parse(s) as Record<string, unknown>
      return [{
        id:             job.id as string,
        type:           job.type as string,
        payload:        ((job.payload ?? {}) as Record<string, unknown>),
        priority:       Number(job.priority ?? 100),
        priority_label: priorityLabel(Number(job.priority ?? 100)) as JobPriority,
        error:          (job.error_message as string | null) ?? null,
        retry_count:    Number(job.retry_count ?? 0),
        max_retries:    Number(job.max_retries ?? 3),
        failed_at:      (job.failed_at as string | null) ?? null,
        created_at:     job.created_at as string,
      } satisfies DLQEntry]
    } catch {
      return []
    }
  })
}

// ── Processing (in-flight) jobs ───────────────────────────────────────────────

export async function getProcessingJobs(): Promise<Record<string, unknown>[]> {
  const hash = await getClient().hgetall(KEY_PROCESSING)
  if (!hash) return []
  return Object.values(hash).flatMap((s) => {
    try { return [JSON.parse(s) as Record<string, unknown>] } catch { return [] }
  })
}

// ── Done list ─────────────────────────────────────────────────────────────────

export async function getRecentCompleted(limit = 100): Promise<string[]> {
  return getClient().lrange(KEY_DONE, 0, limit - 1)
}

// ── Cancel — remove a specific job from its priority queue ───────────────────

/**
 * Locate and remove a pending job from its sorted-set lane using ZSCAN.
 * ZSCAN is preferred over ZRANGEBYSCORE with a pattern because job JSON
 * members may vary in field ordering; a full-scan MATCH on the id field
 * is the most reliable approach without a secondary index.
 */
export async function removeFromQueue(jobId: string, priority: number): Promise<boolean> {
  const key = laneKey(priority)
  const client = getClient()
  let cursor = '0'

  do {
    const [next, elements] = await client.zscan(key, cursor, 'COUNT', 200)
    cursor = next
    // elements = [member, score, member, score, ...]
    for (let i = 0; i < elements.length; i += 2) {
      const member = elements[i]
      try {
        const parsed = JSON.parse(member) as { id?: string }
        if (parsed.id === jobId) {
          await client.zrem(key, member)
          return true
        }
      } catch { /* skip malformed entries */ }
    }
  } while (cursor !== '0')

  return false
}

// ── Pub/Sub ───────────────────────────────────────────────────────────────────

/**
 * Subscribe to the job-lifecycle events channel.
 * ioredis requires a dedicated client in subscriber mode; getSubscriber()
 * maintains a separate singleton for this purpose.
 * Returns an unsubscribe function that restores the client to normal mode.
 */
export async function subscribeToEvents(
  onMessage: (channel: string, message: string) => void
): Promise<() => Promise<void>> {
  const sub = getSubscriber()
  if (sub.status !== 'ready') await sub.connect()

  sub.on('message', onMessage)
  await sub.subscribe(KEY_EVENTS)

  return async () => {
    await sub.unsubscribe(KEY_EVENTS)
    sub.removeListener('message', onMessage)
  }
}

/**
 * Publish an event payload to the job-lifecycle pub/sub channel.
 * Used by the API when it performs state changes (cancel, manual retry).
 */
export async function publishEvent(payload: unknown): Promise<void> {
  await getClient().publish(KEY_EVENTS, JSON.stringify(payload))
}
