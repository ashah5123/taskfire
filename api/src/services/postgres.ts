import { Pool, PoolClient } from 'pg'
import type { Job, JobLog, JobStatus, ListJobsQuery } from '../types/job'
import { priorityLabel, PRIORITY_VALUE } from '../types/job'

let pool: Pool

function getPool(): Pool {
  if (pool) return pool
  pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://taskfire:taskfire@localhost:5432/taskfire',
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  pool.on('error', (err) => {
    // Surface unexpected idle-client errors without crashing.
    void err
  })
  return pool
}

export async function connectPostgresWithRetry(maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const pg = getPool()
      const client = await pg.connect()
      client.release()
      return
    } catch (err) {
      if (attempt === maxAttempts) throw err
      await new Promise((res) => setTimeout(res, attempt * 2000))
    }
  }
}

export async function closePostgres(): Promise<void> {
  if (pool) await pool.end()
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const pg = getPool()
  const client: PoolClient = await pg.connect()
  try {
    const result = await client.query<T>(sql, params)
    return result.rows
  } finally {
    client.release()
  }
}

// ── Row → Job mapping ─────────────────────────────────────────────────────────

function rowToJob(row: Record<string, unknown>): Job {
  const priority = Number(row.priority ?? 100)
  return {
    id: row.id as string,
    type: row.type as string,
    payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
    priority,
    priority_label: priorityLabel(priority),
    status: row.status as JobStatus,
    max_retries: Number(row.max_retries ?? 3),
    retry_count: Number(row.retry_count ?? 0),
    created_at: (row.created_at as Date).toISOString(),
    started_at: row.started_at ? (row.started_at as Date).toISOString() : null,
    completed_at: row.completed_at ? (row.completed_at as Date).toISOString() : null,
    failed_at: row.failed_at ? (row.failed_at as Date).toISOString() : null,
    error: (row.error as string | null) ?? null,
    scheduled_at: row.scheduled_at ? (row.scheduled_at as Date).toISOString() : null,
    dependencies: Array.isArray(row.dependencies)
      ? (row.dependencies as string[])
      : typeof row.dependencies === 'string'
      ? (JSON.parse(row.dependencies) as string[])
      : [],
  }
}

// ── Job CRUD ──────────────────────────────────────────────────────────────────

export interface InsertJobParams {
  id: string
  type: string
  payload: Record<string, unknown>
  priority: number
  max_retries: number
  scheduled_at?: string | null
  dependencies?: string[]
}

export async function insertJob(params: InsertJobParams): Promise<Job> {
  const rows = await query<Record<string, unknown>>(
    `INSERT INTO jobs
       (id, type, payload, priority, max_retries, retry_count, status, scheduled_at, dependencies, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, 'pending', $6, $7, NOW())
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
  return rowToJob(rows[0])
}

export async function getJobs(opts: ListJobsQuery): Promise<{ rows: Job[]; total: number }> {
  const { status, priority, type, limit = 50, page = 1 } = opts
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (status) {
    conditions.push(`status = $${idx++}`)
    params.push(status)
  }
  if (priority) {
    conditions.push(`priority = $${idx++}`)
    params.push(PRIORITY_VALUE[priority])
  }
  if (type) {
    conditions.push(`type = $${idx++}`)
    params.push(type)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countRows = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM jobs ${where}`,
    params
  )
  const total = parseInt(countRows[0]?.count ?? '0', 10)

  const listParams = [...params, limit, offset]
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    listParams
  )

  return { rows: rows.map(rowToJob), total }
}

export async function getJobById(id: string): Promise<Job | null> {
  const rows = await query<Record<string, unknown>>(
    'SELECT * FROM jobs WHERE id = $1',
    [id]
  )
  return rows[0] ? rowToJob(rows[0]) : null
}

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

export async function requeueJob(id: string, resetRetries: boolean): Promise<Job | null> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE jobs
     SET status = 'pending',
         retry_count = CASE WHEN $2 THEN 0 ELSE retry_count END,
         error = NULL,
         failed_at = NULL,
         started_at = NULL,
         completed_at = NULL
     WHERE id = $1 AND status IN ('failed', 'dead')
     RETURNING *`,
    [id, resetRetries]
  )
  return rows[0] ? rowToJob(rows[0]) : null
}

export async function updateJobStatus(
  id: string,
  status: JobStatus,
  extra: Partial<Record<string, unknown>> = {}
): Promise<void> {
  const setClauses = ['status = $2']
  const values: unknown[] = [id, status]
  let idx = 3
  for (const [key, val] of Object.entries(extra)) {
    setClauses.push(`${key} = $${idx++}`)
    values.push(val)
  }
  await query(`UPDATE jobs SET ${setClauses.join(', ')} WHERE id = $1`, values)
}

// ── Job logs ──────────────────────────────────────────────────────────────────

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
    timestamp: (row.created_at as Date).toISOString(),
    detail: `job type="${row.type as string}" priority=${row.priority as number}`,
  })

  if (row.started_at) {
    logs.push({
      event: 'started',
      timestamp: (row.started_at as Date).toISOString(),
      detail: `attempt ${(row.retry_count as number) + 1} of ${(row.max_retries as number) + 1}`,
    })
  }

  if (row.completed_at) {
    const startMs = row.started_at ? (row.started_at as Date).getTime() : null
    const endMs = (row.completed_at as Date).getTime()
    const durationMs = startMs !== null ? endMs - startMs : null
    logs.push({
      event: 'completed',
      timestamp: (row.completed_at as Date).toISOString(),
      detail: durationMs !== null ? `processing_time=${durationMs}ms` : null,
    })
  }

  if (row.failed_at) {
    logs.push({
      event: row.status === 'dead' ? 'dead' : 'failed',
      timestamp: (row.failed_at as Date).toISOString(),
      detail: (row.error as string | null) ?? null,
    })
  }

  return logs
}

// ── Metrics queries ───────────────────────────────────────────────────────────

export interface StatusCounts {
  pending: number
  active: number
  completed: number
  failed: number
  dead: number
}

export async function getStatusCounts(): Promise<StatusCounts> {
  const rows = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`
  )
  const map = Object.fromEntries(rows.map((r) => [r.status, parseInt(r.count, 10)]))
  return {
    pending: map['pending'] ?? 0,
    active: map['active'] ?? 0,
    completed: map['completed'] ?? 0,
    failed: map['failed'] ?? 0,
    dead: map['dead'] ?? 0,
  }
}

export async function getAvgProcessingMs(): Promise<number | null> {
  const rows = await query<{ avg_ms: string | null }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::numeric(12,2) AS avg_ms
     FROM jobs
     WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL`
  )
  const val = rows[0]?.avg_ms
  return val !== null && val !== undefined ? parseFloat(val) : null
}

export interface ThroughputRow {
  time: string
  completed: number
  failed: number
}

export async function getThroughput(): Promise<ThroughputRow[]> {
  const rows = await query<{ minute: Date; completed: string; failed: string }>(
    `SELECT
       date_trunc('minute', completed_at)                                        AS minute,
       COUNT(*) FILTER (WHERE status = 'completed')                              AS completed,
       COUNT(*) FILTER (WHERE status IN ('failed', 'dead'))                      AS failed
     FROM jobs
     WHERE completed_at > NOW() - INTERVAL '60 minutes'
       AND completed_at IS NOT NULL
     GROUP BY 1
     ORDER BY 1`
  )
  return rows.map((r) => ({
    time: r.minute.toISOString(),
    completed: parseInt(r.completed, 10),
    failed: parseInt(r.failed, 10),
  }))
}

export interface ActiveJobRow {
  id: string
  type: string
  started_at: Date
}

export async function getActiveJobs(): Promise<ActiveJobRow[]> {
  const rows = await query<{ id: string; type: string; started_at: Date }>(
    `SELECT id, type, started_at FROM jobs WHERE status = 'active' ORDER BY started_at`
  )
  return rows
}
