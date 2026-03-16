import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { LiveMetrics } from '../types/job'

// Use shared recharts mock from dashboard/__mocks__/recharts.tsx
vi.mock('recharts')

import { QueueDepthChart } from '../components/QueueDepthChart'

const makeLiveMetrics = (high = 3, medium = 5, low = 1): LiveMetrics => ({
  queue_depth: { high, medium, low, delayed: 0, total: high + medium + low },
  dlq_depth: 0,
  active_jobs: 2,
  pending_jobs: high + medium + low,
  counts: { pending: 9, active: 2, completed: 50, failed: 1, dead: 0 },
  timestamp: new Date().toISOString(),
})

describe('QueueDepthChart', () => {
  it('shows waiting message when liveMetrics is null', () => {
    render(<QueueDepthChart liveMetrics={null} />)
    expect(screen.getByText(/waiting for data/i)).toBeInTheDocument()
  })

  it('renders chart container when liveMetrics is provided', () => {
    render(<QueueDepthChart liveMetrics={makeLiveMetrics()} />)
    expect(screen.getByTestId('recharts-responsive-container')).toBeInTheDocument()
  })

  it('renders line chart when data is available', () => {
    render(<QueueDepthChart liveMetrics={makeLiveMetrics(2, 4, 1)} />)
    expect(screen.getByTestId('recharts-line-chart')).toBeInTheDocument()
  })
})
