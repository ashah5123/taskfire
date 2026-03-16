import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosRetry from 'axios-retry'
import type {
  Job,
  JobListResponse,
  JobLogsResponse,
  CreateJobInput,
  ListJobsParams,
  RetryJobInput,
  QueueMetrics,
  ThroughputPoint,
  FailureRatePoint,
  WorkerMetrics,
  DLQListResponse,
} from '../types/job'

// ── Typed API error ───────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ── Axios instance ────────────────────────────────────────────────────────────

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? ''

const instance: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

// Retry on network failures and 5xx responses — never retry 4xx (client errors).
axiosRetry(instance, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error: AxiosError) => {
    if (axiosRetry.isNetworkError(error)) return true
    const status = error.response?.status
    return status !== undefined && status >= 500
  },
  onRetry: (retryCount, error) => {
    console.warn(`[api] retry ${retryCount} for ${error.config?.url ?? '?'}: ${error.message}`)
  },
})

// Request interceptor — attach a trace ID so errors can be correlated in logs.
instance.interceptors.request.use((config) => {
  config.headers['X-Request-ID'] = crypto.randomUUID()
  return config
})

// Response interceptor — normalise error shape into ApiError.
instance.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error?: string; message?: string; details?: Array<{ path: string; message: string }> }>) => {
    if (error.response) {
      const { status, data } = error.response
      throw new ApiError(
        status,
        data?.error ?? 'api_error',
        data?.message ?? `Request failed with status ${status}`,
        data?.details
      )
    }
    if (error.request) {
      throw new ApiError(0, 'network_error', 'Network request failed — the server may be unreachable')
    }
    throw new ApiError(0, 'client_error', error.message)
  }
)

// ── Helper ────────────────────────────────────────────────────────────────────

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== '') qs.set(key, String(val))
  }
  const str = qs.toString()
  return str ? `?${str}` : ''
}

// ── API surface ───────────────────────────────────────────────────────────────

export const api = {
  jobs: {
    list(params: ListJobsParams = {}): Promise<JobListResponse> {
      const qs = buildQuery({
        status:   params.status,
        priority: params.priority,
        type:     params.type,
        page:     params.page,
        limit:    params.limit,
      })
      return instance.get<JobListResponse>(`/api/jobs${qs}`).then((r) => r.data)
    },

    get(id: string): Promise<Job> {
      return instance.get<Job>(`/api/jobs/${id}`).then((r) => r.data)
    },

    create(input: CreateJobInput): Promise<Job> {
      return instance.post<Job>('/api/jobs', input).then((r) => r.data)
    },

    cancel(id: string): Promise<void> {
      return instance.delete(`/api/jobs/${id}`).then(() => undefined)
    },

    retry(id: string, input: RetryJobInput = {}): Promise<Job> {
      return instance.post<Job>(`/api/jobs/${id}/retry`, input).then((r) => r.data)
    },

    getLogs(id: string): Promise<JobLogsResponse> {
      return instance.get<JobLogsResponse>(`/api/jobs/${id}/logs`).then((r) => r.data)
    },
  },

  metrics: {
    summary(): Promise<QueueMetrics> {
      return instance.get<QueueMetrics>('/api/metrics/summary').then((r) => r.data)
    },

    throughput(): Promise<ThroughputPoint[]> {
      return instance.get<ThroughputPoint[]>('/api/metrics/throughput').then((r) => r.data)
    },

    workers(): Promise<WorkerMetrics> {
      return instance.get<WorkerMetrics>('/api/metrics/workers').then((r) => r.data)
    },

    deadLetter(params: { limit?: number; offset?: number } = {}): Promise<DLQListResponse> {
      const qs = buildQuery({ limit: params.limit, offset: params.offset })
      return instance.get<DLQListResponse>(`/api/metrics/dead-letter${qs}`).then((r) => r.data)
    },

    // Derive failure-rate series from the throughput endpoint so that the
    // FailureRateChart component can keep its existing interface unchanged.
    async failureRate(): Promise<FailureRatePoint[]> {
      const rows = await this.throughput()
      return rows.map((r) => {
        const total = r.completed + r.failed
        return {
          time:   r.time,
          total,
          failed: r.failed,
          rate:   total > 0 ? r.failed / total : 0,
        }
      })
    },
  },
}
