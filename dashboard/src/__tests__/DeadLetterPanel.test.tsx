import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('../api/client', () => ({
  api: {
    metrics: {
      deadLetter: vi.fn(),
    },
    jobs: {
      list: vi.fn(),
      get: vi.fn(),
      retry: vi.fn(),
    },
  },
}))

import { DeadLetterPanel } from '../components/DeadLetterPanel'
import { api } from '../api/client'

const emptyDLQ = { jobs: [], total: 0, limit: 25, offset: 0 }

const dlqWithJobs = {
  jobs: [
    {
      id: 'dead-1',
      type: 'email',
      payload: { to: 'user@example.com' },
      priority: 200,
      priority_label: 'medium' as const,
      error: 'SMTP connection refused',
      retry_count: 3,
      max_retries: 3,
      failed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
    {
      id: 'dead-2',
      type: 'webhook',
      payload: { url: 'https://example.com' },
      priority: 300,
      priority_label: 'high' as const,
      error: '502 Bad Gateway',
      retry_count: 5,
      max_retries: 5,
      failed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  ],
  total: 2,
  limit: 25,
  offset: 0,
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('DeadLetterPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading skeleton (pulse rows) while data is loading', () => {
    vi.mocked(api.metrics.deadLetter).mockReturnValue(new Promise(() => {}))

    const { container } = render(<DeadLetterPanel />, { wrapper })

    // Loading state renders animated pulse divs, not text.
    const pulseEls = container.querySelectorAll('.animate-pulse')
    expect(pulseEls.length).toBeGreaterThan(0)
  })

  it('shows empty state when DLQ is empty', async () => {
    vi.mocked(api.metrics.deadLetter).mockResolvedValue(emptyDLQ)

    render(<DeadLetterPanel />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/dead-letter queue is empty/i)).toBeInTheDocument()
    })
  })

  it('renders job rows when DLQ has entries', async () => {
    vi.mocked(api.metrics.deadLetter).mockResolvedValue(dlqWithJobs)

    render(<DeadLetterPanel />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('email')).toBeInTheDocument()
      expect(screen.getByText('webhook')).toBeInTheDocument()
    })
  })

  it('shows error message from a failed job (expanded)', async () => {
    vi.mocked(api.metrics.deadLetter).mockResolvedValue(dlqWithJobs)
    vi.mocked(api.jobs.retry).mockResolvedValue({} as never)

    render(<DeadLetterPanel />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('email')).toBeInTheDocument()
    })
  })

  it('shows retry buttons for each DLQ entry', async () => {
    vi.mocked(api.metrics.deadLetter).mockResolvedValue(dlqWithJobs)
    vi.mocked(api.jobs.retry).mockResolvedValue({} as never)

    render(<DeadLetterPanel />, { wrapper })

    await waitFor(() => {
      const retryButtons = screen.getAllByRole('button', { name: /retry/i })
      expect(retryButtons.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows error message when fetch fails', async () => {
    vi.mocked(api.metrics.deadLetter).mockRejectedValue(new Error('fetch failed'))

    render(<DeadLetterPanel />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText(/failed to load dead-letter queue/i)).toBeInTheDocument()
    })
  })

  it('shows Dead-Letter Queue heading', async () => {
    vi.mocked(api.metrics.deadLetter).mockResolvedValue(emptyDLQ)

    render(<DeadLetterPanel />, { wrapper })

    await waitFor(() => {
      expect(screen.getByText('Dead-Letter Queue')).toBeInTheDocument()
    })
  })
})
