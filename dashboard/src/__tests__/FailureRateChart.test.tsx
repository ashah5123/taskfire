import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

// Use shared recharts mock from dashboard/__mocks__/recharts.tsx
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

import { FailureRateChart } from '../components/FailureRateChart'
import { api } from '../api/client'

const okSummary = {
  queue_depth: { high: 0, medium: 0, low: 0, delayed: 0, total: 0 },
  dlq_depth: 0,
  counts: { pending: 0, active: 0, completed: 100, failed: 2, dead: 0, total_processed: 102 },
  failure_rate: 0.02,
  avg_processing_ms: 40,
}

const highFailureSummary = {
  ...okSummary,
  counts: { ...okSummary.counts, failed: 30 },
  failure_rate: 0.3,
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('FailureRateChart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "Loading metrics…" on initial render', () => {
    vi.mocked(api.metrics.summary).mockReturnValue(new Promise(() => {}))

    render(<FailureRateChart />, { wrapper })

    expect(screen.getByText('Loading metrics…')).toBeInTheDocument()
  })

  it('renders chart container when data is available', async () => {
    vi.mocked(api.metrics.summary).mockResolvedValue(okSummary)

    render(<FailureRateChart />, { wrapper })

    await waitFor(() => {
      expect(screen.getByTestId('recharts-responsive-container')).toBeInTheDocument()
    })
  })

  it('shows ⚠ alert badge when failure rate exceeds 5%', async () => {
    vi.mocked(api.metrics.summary).mockResolvedValue(highFailureSummary)

    render(<FailureRateChart />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/above 5%/i)).toBeInTheDocument()
    })
  })

  it('shows "Failed to load" when fetch fails', async () => {
    vi.mocked(api.metrics.summary).mockRejectedValue(new Error('timeout'))

    render(<FailureRateChart />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument()
    })
  })

  it('shows failure rate percentage when data is available', async () => {
    vi.mocked(api.metrics.summary).mockResolvedValue(okSummary)

    render(<FailureRateChart />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/%/)).toBeInTheDocument()
    })
  })
})
