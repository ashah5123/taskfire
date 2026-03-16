import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

// WorkerUtilization uses recharts — mock it to avoid ResizeObserver issues in jsdom.
vi.mock('recharts')

vi.mock('../api/client', () => ({
  api: {
    metrics: {
      throughput: vi.fn(),
      summary: vi.fn(),
      workers: vi.fn(),
    },
    jobs: {
      list: vi.fn(),
      deadLetter: vi.fn(),
    },
  },
}))

import { WorkerUtilization } from '../components/WorkerUtilization'
import { api } from '../api/client'
import type { LiveMetrics } from '../types/job'

const liveMock: LiveMetrics = {
  queue_depth: { high: 0, medium: 0, low: 0, delayed: 0, total: 0 },
  dlq_depth: 0,
  active_jobs: 0,
  pending_jobs: 0,
  counts: { pending: 0, active: 0, completed: 0, failed: 0, dead: 0 },
  timestamp: new Date().toISOString(),
}

const busyWorkers = {
  active_workers: 3,
  in_flight_redis: 3,
  discrepancy: 0,
  active_jobs: [
    { job_id: 'j1', job_type: 'email',   started_at: new Date().toISOString(), running_for_ms: 1200 },
    { job_id: 'j2', job_type: 'webhook', started_at: new Date().toISOString(), running_for_ms: 800 },
    { job_id: 'j3', job_type: 'noop',    started_at: new Date().toISOString(), running_for_ms: 200 },
  ],
  processing_ids_redis: ['j1', 'j2', 'j3'],
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('WorkerUtilization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Worker Utilization heading', () => {
    vi.mocked(api.metrics.workers).mockReturnValue(new Promise(() => {}))

    render(<WorkerUtilization liveMetrics={null} />, { wrapper })

    expect(screen.getByText('Worker Utilization')).toBeInTheDocument()
  })

  it('shows 0/10 active when no workers', async () => {
    vi.mocked(api.metrics.workers).mockResolvedValue({
      active_workers: 0,
      in_flight_redis: 0,
      discrepancy: 0,
      active_jobs: [],
      processing_ids_redis: [],
    })

    render(<WorkerUtilization liveMetrics={liveMock} />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/0\/\d+ active/)).toBeInTheDocument()
    })
  })

  it('shows active worker count when workers are busy', async () => {
    vi.mocked(api.metrics.workers).mockResolvedValue(busyWorkers)

    render(<WorkerUtilization liveMetrics={liveMock} />, { wrapper })

    await waitFor(() => {
      // Component renders "{activeJobs}/{totalWorkers} active"
      expect(screen.getByText(/3\/\d+ active/)).toBeInTheDocument()
    })
  })

  it('renders the chart container', async () => {
    vi.mocked(api.metrics.workers).mockResolvedValue(busyWorkers)

    render(<WorkerUtilization liveMetrics={liveMock} />, { wrapper })

    await waitFor(() => {
      expect(screen.getByTestId('recharts-responsive-container')).toBeInTheDocument()
    })
  })
})
