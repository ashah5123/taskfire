export type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'dead'

export interface Job {
  id: string
  type: string
  payload: Record<string, unknown>
  priority: number
  status: JobStatus
  max_retries: number
  retry_count: number
  created_at: string
  started_at?: string
  completed_at?: string
  failed_at?: string
  error?: string
  scheduled_at?: string
  dependencies?: string[]
}

export interface MetricsOverview {
  queue_depth: number
  dlq_depth: number
  by_status: Record<JobStatus, number>
  completed_last_1k: number
}

export interface ThroughputPoint {
  time: string
  count: number
}

export interface FailureRatePoint {
  time: string
  total: number
  failed: number
  rate: number
}

export interface LiveMetrics {
  queue_depth: number
  dlq_depth: number
  active_jobs: number
  timestamp: string
}
