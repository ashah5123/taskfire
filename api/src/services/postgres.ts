import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://taskfire:taskfire@localhost:5432/taskfire',
  max: 20,
  idleTimeoutMillis: 30000,
})

export async function query<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect()
  try {
    const result = await client.query(sql, params)
    return result.rows
  } finally {
    client.release()
  }
}

export async function insertJob(job: {
  id: string
  type: string
  payload: object
  priority: number
  max_retries: number
  status: string
  scheduled_at?: string | null
  dependencies?: string[]
}): Promise<void> {
  await query(
    `INSERT INTO jobs (id, type, payload, priority, max_retries, status, scheduled_at, dependencies, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      job.id,
      job.type,
      JSON.stringify(job.payload),
      job.priority,
      job.max_retries,
      job.status,
      job.scheduled_at ?? null,
      JSON.stringify(job.dependencies ?? []),
    ]
  )
}

export async function updateJobStatus(
  id: string,
  status: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const setClauses: string[] = ['status = $2']
  const values: unknown[] = [id, status]
  let idx = 3
  for (const [key, val] of Object.entries(extra)) {
    setClauses.push(`${key} = $${idx++}`)
    values.push(val)
  }
  await query(`UPDATE jobs SET ${setClauses.join(', ')} WHERE id = $1`, values)
}

export async function getJobs(opts: {
  status?: string
  limit?: number
  offset?: number
}): Promise<{ rows: any[]; total: number }> {
  const { status, limit = 50, offset = 0 } = opts
  const where = status ? `WHERE status = $3` : ''
  const params: unknown[] = [limit, offset]
  if (status) params.push(status)

  const rows = await query(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    params
  )
  const [{ count }] = await query(
    `SELECT COUNT(*) as count FROM jobs ${status ? `WHERE status = $1` : ''}`,
    status ? [status] : []
  )
  return { rows, total: parseInt(count, 10) }
}

export async function getJobById(id: string): Promise<any | null> {
  const rows = await query('SELECT * FROM jobs WHERE id = $1', [id])
  return rows[0] ?? null
}
