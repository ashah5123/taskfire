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

import { ThroughputChart } from '../components/ThroughputChart'
import { api } from '../api/client'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('ThroughputChart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "Loading throughput data…" on initial render', () => {
    // Promise never resolves — component stays in loading state.
    vi.mocked(api.metrics.throughput).mockReturnValue(new Promise(() => {}))

    render(<ThroughputChart />, { wrapper })

    expect(screen.getByText('Loading throughput data…')).toBeInTheDocument()
  })

  it('renders chart container when data is returned', async () => {
    vi.mocked(api.metrics.throughput).mockResolvedValue([
      { time: '2024-01-01T00:00:00Z', completed: 10, failed: 1 },
    ])

    render(<ThroughputChart />, { wrapper })

    await waitFor(() => {
      expect(screen.getByTestId('recharts-responsive-container')).toBeInTheDocument()
    })
  })

  it('shows "No throughput data yet" when array is empty', async () => {
    vi.mocked(api.metrics.throughput).mockResolvedValue([])

    render(<ThroughputChart />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('No throughput data yet')).toBeInTheDocument()
    })
  })

  it('shows "Failed to load" when fetch fails', async () => {
    vi.mocked(api.metrics.throughput).mockRejectedValue(new Error('network error'))

    render(<ThroughputChart />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument()
    })
  })
})
