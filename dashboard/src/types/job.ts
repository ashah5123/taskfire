// ── Enumerations ──────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'dead'
export type JobPriority = 'high' | 'medium' | 'low'

// ── Core domain types ─────────────────────────────────────────────────────────

export interface Job {
  id: string
  type: string
  payload: Record<string, unknown>
  priority: number
  priority_label: JobPriority
  status: JobStatus
  max_retries: number
  retry_count: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  failed_at: string | null
  error: string | null
  scheduled_at: string | null
  dependencies: string[]
}

export interface JobLog {
  event: string
  timestamp: string
  detail: string | null
}

export interface JobLogsResponse {
  job_id: string
  job_type: string
  logs: JobLog[]
}

export interface JobListResponse {
  jobs: Job[]
  total: number
  page: number
  limit: number
  pages: number
}

export interface CreateJobInput {
  type: string
  payload?: Record<string, unknown>
  priority?: JobPriority
  max_retries?: number
  scheduled_at?: string
  dependencies?: string[]
}

export interface ListJobsParams {
  status?: JobStatus
  priority?: JobPriority
  type?: string
  page?: number
  limit?: number
}

export interface RetryJobInput {
  reset_retries?: boolean
}

// ── Job events (WebSocket pub/sub) ────────────────────────────────────────────

export interface JobEvent {
  type: 'started' | 'completed' | 'failed' | 'retry' | 'dead'
  job_id: string
  job_type: string
  status: JobStatus
  timestamp: string
  worker_id?: number
  error?: string
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface QueueDepthByLane {
  high: number
  medium: number
  low: number
  delayed: number
  total: number
}

export interface MetricsCounts {
  pending: number
  active: number
  completed: number
  failed: number
  dead: number
  total_processed: number
}

export interface QueueMetrics {
  queue_depth: QueueDepthByLane
  dlq_depth: number
  counts: MetricsCounts
  failure_rate: number
  avg_processing_ms: number | null
}

export interface ThroughputPoint {
  time: string
  completed: number
  failed: number
}

export interface FailureRatePoint {
  time: string
  total: number
  failed: number
  rate: number
}

export interface ActiveJobSummary {
  job_id: string
  job_type: string
  started_at: string
  running_for_ms: number
}

export interface WorkerMetrics {
  active_workers: number
  in_flight_redis: number
  discrepancy: number
  active_jobs: ActiveJobSummary[]
  processing_ids_redis: string[]
}

// ── Dead-letter queue ─────────────────────────────────────────────────────────

export interface DLQEntry {
  id: string
  type: string
  payload: Record<string, unknown>
  priority: number
  priority_label: JobPriority
  error: string | null
  retry_count: number
  max_retries: number
  failed_at: string | null
  created_at: string
}

export interface DLQListResponse {
  jobs: DLQEntry[]
  total: number
  limit: number
  offset: number
}

// ── WebSocket push payload ────────────────────────────────────────────────────

export interface LiveMetrics {
  queue_depth: QueueDepthByLane
  dlq_depth: number
  active_jobs: number
  pending_jobs: number
  counts: Omit<MetricsCounts, 'total_processed'>
  timestamp: string
}

export interface SnapshotPayload extends LiveMetrics {}

// ── WebSocket message union ───────────────────────────────────────────────────

export type WsMessage =
  | { type: 'connected';  payload: { message: string; clients: number; connected_at: string } }
  | { type: 'snapshot';   payload: SnapshotPayload }
  | { type: 'metrics';    payload: LiveMetrics }
  | { type: 'job_event';  payload: JobEvent }
  | { type: 'pong';       payload: { timestamp: string } }
  | { type: 'error';      payload: { code: string; message: string } }
