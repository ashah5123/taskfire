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

export interface CreateJobDto {
  type: string
  payload?: Record<string, unknown>
  priority?: number
  max_retries?: number
  scheduled_at?: string
  dependencies?: string[]
}

export interface JobListResponse {
  jobs: Job[]
  total: number
  page: number
  limit: number
}
