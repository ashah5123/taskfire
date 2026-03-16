import { Pool, PoolClient, QueryResult } from 'pg'
import type { Job, JobLog, JobStatus, ListJobsQuery } from '../types/job'
import { priorityLabel, PRIORITY_VALUE } from '../types/job'

// ── Pool singleton ────────────────────────────────────────────────────────────

let _pool: Pool | null = null

function getPool(): Pool {
  if (_pool) return _pool
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://taskfire:taskfire@localhost:5432/taskfire',
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
  })
  _pool.on('error', (_err: Error) => {
    // Suppress idle-client errors; they surface through query rejections.
  })
  return _pool
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function connectPostgresWithRetry(maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client: PoolClient | null = null
    try {
      client = await getPool().connect()
      await client.query('SELECT 1')
      return
    } catch (err) {
      if (attempt === maxAttempts) throw err
      await new Promise<void>((res) => setTimeout(res, attempt * 2_000))
    } finally {
      client?.release()
    }
  }
}

export async function closePostgres(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}

// ── Low-level query helpers ───────────────────────────────────────────────────

/**
 * Execute a single parameterised query and return all rows.
 * Acquires and releases a pool connection automatically.
 */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = await getPool().connect()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: QueryResult<any> = await client.query(sql, params)
    return result.rows
  } finally {
    client.release()
  }
}

/**
 * Run a sequence of operations inside a single serialisable transaction.
 * The client is automatically committed on success and rolled back on any
 * thrown error. The caller never needs to issue BEGIN / COMMIT / ROLLBACK.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ── Row → Job mapping ─────────────────────────────────────────────────────────

function rowToJob(row: Record<string, unknown>): Job {
  const priority = Number(row['priority'] ?? 100)
  const parsedPayload = (() => {
    const p = row['payload']
    if (typeof p === 'string') return JSON.parse(p) as Record<string, unknown>
    return (p ?? {}) as Record<string, unknown>
  })()
  const parsedDeps = (() => {
    const d = row['dependencies']
    if (Array.isArray(d)) return d as string[]
    if (typeof d === 'string') return JSON.parse(d) as string[]
    return [] as string[]
  })()

  return {
    id:            row['id'] as string,
    type:          row['type'] as string,
    payload:       parsedPayload,
    priority,
    priority_label: priorityLabel(priority),
    status:        row['status'] as JobStatus,
    max_retries:   Number(row['max_retries'] ?? 3),
    retry_count:   Number(row['retry_count'] ?? 0),
    created_at:    (row['created_at'] as Date).toISOString(),
    started_at:    row['started_at']    ? (row['started_at']    as Date).toISOString() : null,
    completed_at:  row['completed_at']  ? (row['completed_at']  as Date).toISOString() : null,
    failed_at:     row['failed_at']     ? (row['failed_at']     as Date).toISOString() : null,
    error:         (row['error'] as string | null) ?? null,
    scheduled_at:  row['scheduled_at']  ? (row['scheduled_at']  as Date).toISOString() : null,
    dependencies:  parsedDeps,
  }
}

// ── Job CRUD ──────────────────────────────────────────────────────────────────

export interface CreateJobParams {
  id: string
  type: string
  payload: Record<string, unknown>
  priority: number
  max_retries: number
  scheduled_at?: string | null
  dependencies?: string[]
}

/**
 * Insert a new job record and return the persisted row.
 * Uses RETURNING * so callers get server-assigned defaults (created_at, etc.)
 * without a second round-trip.
 */
export async function createJob(params: CreateJobParams): Promise<Job> {
  const rows = await query<Record<string, unknown>>(
    `INSERT INTO jobs
       (id, type, payload, priority, max_retries, retry_count, status, scheduled_at, dependencies, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, 0, 'pending', $6, $7::jsonb, NOW())
     RETURNING *`,
    [
      params.id,
      params.type,
      JSON.stringify(params.payload),
      params.priority,
      params.max_retries,
      params.scheduled_at ?? null,
      JSON.stringify(params.dependencies ?? []),
    ]
  )
  if (!rows[0]) throw new Error(`INSERT INTO jobs returned no rows for id=${params.id}`)
  return rowToJob(rows[0])
}

// Keep the old alias so existing route code doesn't need a rename.
export const insertJob = createJob

export async function getJob(id: string): Promise<Job | null> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM jobs WHERE id = $1',
    [id]
  )
  return rows[0] ? rowToJob(rows[0]) : null
}

// Keep alias used by route handlers.
export const getJobById = getJob

export interface ListJobsOptions extends ListJobsQuery {}

export async function listJobs(opts: ListJobsOptions): Promise<{ rows: Job[]; total: number }> {
  const { status, priority, type, limit = 50, page = 1 } = opts
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (status) {
    conditions.push(`status = $${idx++}`)
    params.push(status)
  }
  if (priority !== undefined) {
    conditions.push(`priority = $${idx++}`)
    params.push(PRIORITY_VALUE[priority])
  }
  if (type !== undefined) {
    conditions.push(`type = $${idx++}`)
    params.push(type)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  // Run COUNT and SELECT in a single round-trip via a transaction to keep
  // the total and rows consistent with each other.
  return withTransaction(async (client) => {
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM jobs ${where}`,
      params
    )
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10)

    // $idx and $idx+1 are added after the WHERE filters for LIMIT and OFFSET.
    const listRes = await client.query<Record<string, unknown>>(
      `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    return { rows: listRes.rows.map(rowToJob), total }
  })
}

// Keep alias.
export const getJobs = (opts: ListJobsOptions) => listJobs(opts)

/**
 * Atomically update mutable job columns.
 * All column names are derived from a fixed allow-list to prevent any possibility
 * of SQL injection from the `extra` object keys.
 */
const MUTABLE_COLUMNS = new Set([
  'status', 'retry_count', 'error',
  'started_at', 'completed_at', 'failed_at',
  'scheduled_at', 'dependencies',
])

export async function updateJobStatus(
  id: string,
  status: JobStatus,
  extra: Partial<Record<string, unknown>> = {}
): Promise<void> {
  const setClauses: string[] = ['status = $2']
  const values: unknown[] = [id, status]
  let idx = 3

  for (const [col, val] of Object.entries(extra)) {
    if (!MUTABLE_COLUMNS.has(col)) continue // silently skip unknown columns
    setClauses.push(`${col} = $${idx++}`)
    values.push(val)
  }

  await query(
    `UPDATE jobs SET ${setClauses.join(', ')} WHERE id = $1`,
    values
  )
}

/**
 * Cancel a pending, failed, or dead job. Returns the updated row or null if
 * the job was not in a cancellable state (race-safe via WHERE clause).
 */
export async function cancelJob(id: string): Promise<Job | null> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE jobs
     SET status = 'failed', error = 'cancelled by user', failed_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'failed', 'dead')
     RETURNING *`,
    [id]
  )
  return rows[0] ? rowToJob(rows[0]) : null
}

/**
 * Re-queue a failed or dead job for immediate processing.
 * Returns the updated row or null if the job was not in a retriable state.
 */
export async function requeueJob(id: string, resetRetries: boolean): Promise<Job | null> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE jobs
     SET status       = 'pending',
         retry_count  = CASE WHEN $2 THEN 0 ELSE retry_count END,
         error        = NULL,
         failed_at    = NULL,
         started_at   = NULL,
         completed_at = NULL
     WHERE id = $1 AND status IN ('failed', 'dead')
     RETURNING *`,
    [id, resetRetries]
  )
  return rows[0] ? rowToJob(rows[0]) : null
}

// ── Job logs ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct the lifecycle event log for a job from its timestamp columns.
 * If a job_logs table exists in future, this function is the right place to
 * query it — the call-sites don't need to change.
 */
export async function getJobLogs(id: string): Promise<JobLog[]> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM jobs WHERE id = $1',
    [id]
  )
  const row = rows[0]
  if (!row) return []

  const logs: JobLog[] = []

  logs.push({
    event: 'created',
    timestamp: (row['created_at'] as Date).toISOString(),
    detail: `type="${row['type'] as string}" priority=${row['priority'] as number} max_retries=${row['max_retries'] as number}`,
  })

  if (row['scheduled_at']) {
    logs.push({
      event: 'scheduled',
      timestamp: (row['created_at'] as Date).toISOString(),
      detail: `runs_at=${(row['scheduled_at'] as Date).toISOString()}`,
    })
  }

  if (row['started_at']) {
    const attempt = Number(row['retry_count'] ?? 0)
    const maxR    = Number(row['max_retries'] ?? 3)
    logs.push({
      event: 'started',
      timestamp: (row['started_at'] as Date).toISOString(),
      detail: `attempt=${attempt + 1} max_attempts=${maxR + 1}`,
    })
  }

  if (row['completed_at']) {
    const startMs    = row['started_at'] ? (row['started_at'] as Date).getTime() : null
    const endMs      = (row['completed_at'] as Date).getTime()
    const durationMs = startMs !== null ? endMs - startMs : null
    logs.push({
      event: 'completed',
      timestamp: (row['completed_at'] as Date).toISOString(),
      detail: durationMs !== null ? `processing_time_ms=${durationMs}` : null,
    })
  }

  if (row['failed_at']) {
    const isDeadLetter = row['status'] === 'dead'
    logs.push({
      event: isDeadLetter ? 'dead' : 'failed',
      timestamp: (row['failed_at'] as Date).toISOString(),
      detail: (row['error'] as string | null) ?? null,
    })
  }

  return logs
}

// ── Metrics queries ───────────────────────────────────────────────────────────

export interface StatusCounts {
  pending:   number
  active:    number
  completed: number
  failed:    number
  dead:      number
}

export async function getStatusCounts(): Promise<StatusCounts> {
  const rows = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`
  )
  const map: Record<string, number> = {}
  for (const r of rows) map[r.status] = parseInt(r.count, 10)
  return {
    pending:   map['pending']   ?? 0,
    active:    map['active']    ?? 0,
    completed: map['completed'] ?? 0,
    failed:    map['failed']    ?? 0,
    dead:      map['dead']      ?? 0,
  }
}

export async function getAvgProcessingMs(): Promise<number | null> {
  const rows = await query<{ avg_ms: string | null }>(
    `SELECT ROUND(
       AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::numeric,
       2
     ) AS avg_ms
     FROM jobs
     WHERE status = 'completed'
       AND started_at   IS NOT NULL
       AND completed_at IS NOT NULL`
  )
  const val = rows[0]?.avg_ms
  return val != null ? parseFloat(val) : null
}

export interface ThroughputRow {
  time:      string
  completed: number
  failed:    number
}

export async function getThroughput(): Promise<ThroughputRow[]> {
  const rows = await query<{ minute: Date; completed: string; failed: string }>(
    `SELECT
       date_trunc('minute', completed_at) AS minute,
       COUNT(*) FILTER (WHERE status = 'completed')             AS completed,
       COUNT(*) FILTER (WHERE status IN ('failed', 'dead'))     AS failed
     FROM jobs
     WHERE completed_at > NOW() - INTERVAL '60 minutes'
       AND completed_at IS NOT NULL
     GROUP BY 1
     ORDER BY 1`
  )
  return rows.map((r) => ({
    time:      r.minute.toISOString(),
    completed: parseInt(r.completed, 10),
    failed:    parseInt(r.failed,    10),
  }))
}

export interface ActiveJobRow {
  id:         string
  type:       string
  started_at: Date
}

export async function getActiveJobs(): Promise<ActiveJobRow[]> {
  return query<{ id: string; type: string; started_at: Date }>(
    `SELECT id, type, started_at FROM jobs WHERE status = 'active' ORDER BY started_at`
  )
}

/**
 * Aggregate all metrics needed for the /metrics/summary endpoint in a single
 * database round-trip using CTEs, then augment with the avg processing time.
 */
export interface MetricsSummary {
  counts:          StatusCounts
  avg_processing_ms: number | null
}

export async function getMetrics(): Promise<MetricsSummary> {
  const rows = await query<{
    status:  string
    count:   string
    avg_ms:  string | null
  }>(
    `WITH status_counts AS (
       SELECT status, COUNT(*) AS count
       FROM jobs
       GROUP BY status
     ),
     avg_time AS (
       SELECT ROUND(
         AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::numeric,
         2
       ) AS avg_ms
       FROM jobs
       WHERE status = 'completed'
         AND started_at   IS NOT NULL
         AND completed_at IS NOT NULL
     )
     SELECT sc.status, sc.count::text, at.avg_ms::text
     FROM status_counts sc
     CROSS JOIN avg_time at`
  )

  const counts: StatusCounts = { pending: 0, active: 0, completed: 0, failed: 0, dead: 0 }
  let avg_processing_ms: number | null = null

  for (const r of rows) {
    const n = parseInt(r.count, 10)
    if (r.status in counts) counts[r.status as keyof StatusCounts] = n
    if (r.avg_ms != null && avg_processing_ms === null) avg_processing_ms = parseFloat(r.avg_ms)
  }

  return { counts, avg_processing_ms }
}
