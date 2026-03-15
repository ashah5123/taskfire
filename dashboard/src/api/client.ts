import type { Job, MetricsOverview, ThroughputPoint, FailureRatePoint } from '../types/job'

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API error ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  jobs: {
    list(params?: { status?: string; page?: number; limit?: number }) {
      const qs = new URLSearchParams()
      if (params?.status) qs.set('status', params.status)
      if (params?.page) qs.set('page', String(params.page))
      if (params?.limit) qs.set('limit', String(params.limit))
      return request<{ jobs: Job[]; total: number; page: number; limit: number }>(
        `/api/jobs?${qs}`
      )
    },
    get(id: string) {
      return request<Job>(`/api/jobs/${id}`)
    },
    create(body: {
      type: string
      payload?: Record<string, unknown>
      priority?: number
      max_retries?: number
    }) {
      return request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(body) })
    },
    retry(id: string) {
      return request<Job>(`/api/jobs/${id}/retry`, { method: 'POST' })
    },
    cancel(id: string) {
      return request<void>(`/api/jobs/${id}`, { method: 'DELETE' })
    },
  },
  metrics: {
    overview() {
      return request<MetricsOverview>('/api/metrics/overview')
    },
    throughput() {
      return request<ThroughputPoint[]>('/api/metrics/throughput')
    },
    failureRate() {
      return request<FailureRatePoint[]>('/api/metrics/failure-rate')
    },
  },
}
