import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('../hooks/useJobs', () => ({
  useJobs: vi.fn(),
  useJob: vi.fn(),
  useJobLogs: vi.fn().mockReturnValue({ data: undefined, isLoading: false }),
  jobKeys: {
    all: ['jobs'],
    list: () => ['jobs', 'list'],
    detail: (id: string) => ['jobs', 'detail', id],
    logs: (id: string) => ['jobs', 'logs', id],
  },
}))

import { JobTable } from '../components/JobTable'
import { useJobs } from '../hooks/useJobs'

const baseHookResult = {
  jobs: [],
  total: 0,
  pages: 1,
  isLoading: false,
  isFetching: false,
  error: null,
  enqueueJob: vi.fn(),
  cancelJob: vi.fn(),
  retryJob: vi.fn(),
  isEnqueueing: false,
  isCancelling: false,
  isRetrying: false,
}

const sampleJobs = [
  {
    id: 'j1',
    type: 'email',
    payload: { to: 'user@example.com' },
    priority: 200,
    priority_label: 'medium' as const,
    status: 'completed' as const,
    max_retries: 3,
    retry_count: 0,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    failed_at: null,
    error: null,
    scheduled_at: null,
    dependencies: [],
  },
  {
    id: 'j2',
    type: 'webhook',
    payload: { url: 'https://example.com' },
    priority: 300,
    priority_label: 'high' as const,
    status: 'pending' as const,
    max_retries: 3,
    retry_count: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    failed_at: null,
    error: null,
    scheduled_at: null,
    dependencies: [],
  },
  {
    id: 'j3',
    type: 'noop',
    payload: {},
    priority: 100,
    priority_label: 'low' as const,
    status: 'failed' as const,
    max_retries: 3,
    retry_count: 3,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    failed_at: new Date().toISOString(),
    error: 'handler error',
    scheduled_at: null,
    dependencies: [],
  },
]

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('JobTable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading skeleton (pulse rows) when isLoading is true', () => {
    vi.mocked(useJobs).mockReturnValue({ ...baseHookResult, isLoading: true })

    const { container } = render(<JobTable />, { wrapper })

    // The loading state renders animated pulse divs — no textual content.
    const pulseEls = container.querySelectorAll('.animate-pulse')
    expect(pulseEls.length).toBeGreaterThan(0)
  })

  it('shows empty state when no jobs', () => {
    vi.mocked(useJobs).mockReturnValue({ ...baseHookResult, jobs: [] })

    render(<JobTable />, { wrapper })

    expect(screen.getByText(/no jobs/i)).toBeInTheDocument()
  })

  it('renders a row for each job', () => {
    vi.mocked(useJobs).mockReturnValue({
      ...baseHookResult,
      jobs: sampleJobs,
      total: sampleJobs.length,
    })

    render(<JobTable />, { wrapper })

    expect(screen.getByText('email')).toBeInTheDocument()
    expect(screen.getByText('webhook')).toBeInTheDocument()
    expect(screen.getByText('noop')).toBeInTheDocument()
  })

  it('shows status badges in job rows', () => {
    vi.mocked(useJobs).mockReturnValue({
      ...baseHookResult,
      jobs: sampleJobs,
      total: sampleJobs.length,
    })

    render(<JobTable />, { wrapper })

    // getAllByText handles cases where the value also appears in a filter <select>.
    expect(screen.getAllByText('completed').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('pending').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('failed').length).toBeGreaterThanOrEqual(1)
  })

  it('shows cancel button for pending jobs', () => {
    vi.mocked(useJobs).mockReturnValue({
      ...baseHookResult,
      jobs: [sampleJobs[1]], // pending job
      total: 1,
    })

    render(<JobTable />, { wrapper })

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('shows retry button for failed jobs', () => {
    vi.mocked(useJobs).mockReturnValue({
      ...baseHookResult,
      jobs: [sampleJobs[2]], // failed job
      total: 1,
    })

    render(<JobTable />, { wrapper })

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('shows the filter bar with status and priority selects', () => {
    vi.mocked(useJobs).mockReturnValue({ ...baseHookResult })

    render(<JobTable />, { wrapper })

    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBeGreaterThanOrEqual(2)
  })
})
