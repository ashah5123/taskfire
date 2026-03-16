import { z } from 'zod'

// ── Enums ─────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'dead'
export type JobPriority = 'high' | 'medium' | 'low'

export const PRIORITY_VALUE: Record<JobPriority, number> = {
  high: 300,
  medium: 200,
  low: 100,
}

export const PRIORITY_LABEL: Record<number, JobPriority> = {
  300: 'high',
  200: 'medium',
  100: 'low',
}

export function priorityLabel(value: number): JobPriority {
  if (value >= 300) return 'high'
  if (value >= 200) return 'medium'
  return 'low'
}

// ── Core interfaces ───────────────────────────────────────────────────────────

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

export interface JobListResponse {
  jobs: Job[]
  total: number
  page: number
  limit: number
  pages: number
}

export interface JobEvent {
  type: 'started' | 'completed' | 'failed' | 'retry' | 'dead'
  job_id: string
  job_type: string
  status: JobStatus
  timestamp: string
  worker_id?: number
  error?: string
}

// ── Worker / queue metrics ────────────────────────────────────────────────────

export interface QueueDepthByLane {
  high: number
  medium: number
  low: number
  delayed: number
  total: number
}

export interface QueueMetrics {
  queue_depth: QueueDepthByLane
  dlq_depth: number
  total_completed: number
  total_failed: number
  total_dead: number
  failure_rate: number
  avg_processing_ms: number | null
}

export interface WorkerMetrics {
  active_workers: number
  active_jobs: ActiveJobSummary[]
}

export interface ActiveJobSummary {
  job_id: string
  job_type: string
  started_at: string
  running_for_ms: number
}

export interface ThroughputPoint {
  time: string
  completed: number
  failed: number
}

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

// ── Zod schemas ───────────────────────────────────────────────────────────────

export const JobPrioritySchema = z.enum(['high', 'medium', 'low'])

export const CreateJobSchema = z.object({
  type: z
    .string({ required_error: 'type is required' })
    .min(1, 'type must not be empty')
    .max(128, 'type must be at most 128 characters')
    .regex(/^[a-z0-9_:-]+$/i, 'type may only contain letters, digits, underscores, hyphens, and colons'),
  payload: z.record(z.unknown()).optional().default({}),
  priority: JobPrioritySchema.optional().default('low'),
  max_retries: z.number().int().min(0).max(20).optional().default(3),
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  dependencies: z.array(z.string().uuid()).optional().default([]),
})

export type CreateJobInput = z.infer<typeof CreateJobSchema>

export const ListJobsQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'completed', 'failed', 'dead']).optional(),
  priority: JobPrioritySchema.optional(),
  type: z.string().min(1).max(128).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>

export const JobIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
})

export type JobIdParam = z.infer<typeof JobIdParamSchema>

export const RetryJobBodySchema = z.object({
  reset_retries: z.boolean().optional().default(true),
})

export type RetryJobBody = z.infer<typeof RetryJobBodySchema>
