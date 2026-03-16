import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useWebSocket } from './hooks/useWebSocket'
import { MetricCard } from './components/MetricCard'
import { QueueDepthChart } from './components/QueueDepthChart'
import { ThroughputChart } from './components/ThroughputChart'
import { FailureRateChart } from './components/FailureRateChart'
import { WorkerUtilization } from './components/WorkerUtilization'
import { JobTable } from './components/JobTable'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'

// ── Query client ───────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 5_000,
    },
  },
})

// ── Dark mode hook ─────────────────────────────────────────────────────────────

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState<boolean>(() => {
    const stored = localStorage.getItem('tf-dark-mode')
    if (stored !== null) return stored === 'true'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('tf-dark-mode', String(dark))
  }, [dark])

  return [dark, () => setDark((d) => !d)]
}

// ── Navigation types ───────────────────────────────────────────────────────────

type Page = 'overview' | 'jobs' | 'deadletter' | 'workers'

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: 'overview',   label: 'Overview',    icon: '▦' },
  { id: 'jobs',       label: 'Jobs',        icon: '⚡' },
  { id: 'deadletter', label: 'Dead Letter', icon: '☠' },
  { id: 'workers',    label: 'Workers',     icon: '⚙' },
]

// ── Overview page ──────────────────────────────────────────────────────────────

function OverviewPage() {
  const { liveMetrics, snapshot } = useWebSocket()
  const metrics = liveMetrics ?? snapshot

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Queue Depth"
          value={metrics?.queue_depth.total ?? 0}
          subtitle={
            metrics
              ? `H:${metrics.queue_depth.high} M:${metrics.queue_depth.medium} L:${metrics.queue_depth.low}`
              : undefined
          }
          colorScheme="blue"
          higherIsBetter={false}
        />
        <MetricCard
          label="Active Jobs"
          value={metrics?.active_jobs ?? 0}
          colorScheme="green"
        />
        <MetricCard
          label="DLQ Depth"
          value={metrics?.dlq_depth ?? 0}
          colorScheme="red"
          higherIsBetter={false}
        />
        <MetricCard
          label="Completed"
          value={metrics?.counts.completed ?? 0}
          colorScheme="indigo"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QueueDepthChart liveMetrics={metrics} />
        <WorkerUtilization liveMetrics={metrics} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ThroughputChart />
        <FailureRateChart />
      </div>
    </div>
  )
}

// ── Dead Letter page ───────────────────────────────────────────────────────────

function DeadLetterPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dlq'],
    queryFn: () => api.metrics.deadLetter({ limit: 50 }),
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load dead-letter queue.
      </div>
    )
  }

  const jobs = data?.jobs ?? []

  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-600">
        <span className="text-4xl mb-3">✓</span>
        <p className="text-sm font-medium">Dead-letter queue is empty</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} total entries</p>
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <th className="px-4 py-3 text-left font-semibold text-gray-600 dark:text-gray-400">ID</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 dark:text-gray-400">Type</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 dark:text-gray-400">Priority</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 dark:text-gray-400">Retries</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 dark:text-gray-400">Error</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 dark:text-gray-400">Failed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {jobs.map((job) => (
              <tr key={job.id} className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                  {job.id.slice(0, 8)}…
                </td>
                <td className="px-4 py-3 text-gray-900 dark:text-gray-100 font-medium">{job.type}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                    job.priority_label === 'high'
                      ? 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300'
                      : job.priority_label === 'medium'
                      ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                  }`}>
                    {job.priority_label}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                  {job.retry_count}/{job.max_retries}
                </td>
                <td className="px-4 py-3 text-red-600 dark:text-red-400 text-xs font-mono max-w-xs truncate">
                  {job.error ?? '—'}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {job.failed_at ? new Date(job.failed_at).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Workers page ───────────────────────────────────────────────────────────────

function WorkersPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['workers'],
    queryFn: () => api.metrics.workers(),
    refetchInterval: 5_000,
  })

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load worker metrics.
      </div>
    )
  }

  const w = data!

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard label="Active Workers" value={w.active_workers} colorScheme="green" />
        <MetricCard label="In-Flight (Redis)" value={w.in_flight_redis} colorScheme="blue" />
        <MetricCard
          label="Discrepancy"
          value={w.discrepancy}
          colorScheme={w.discrepancy > 0 ? 'red' : 'green'}
          higherIsBetter={false}
          subtitle="Active workers − Redis in-flight"
        />
      </div>

      {w.active_jobs.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="bg-gray-50 dark:bg-gray-800 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Active Jobs ({w.active_jobs.length})
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Job ID</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Type</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Started</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Running</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {w.active_jobs.map((j) => {
                const runSec = Math.round(j.running_for_ms / 1000)
                const runStr = runSec >= 60
                  ? `${Math.floor(runSec / 60)}m ${runSec % 60}s`
                  : `${runSec}s`
                return (
                  <tr key={j.job_id} className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {j.job_id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{j.job_type}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {new Date(j.started_at).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-blue-600 dark:text-blue-400">{runStr} ↺</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {w.active_jobs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400 dark:text-gray-600">
          <span className="text-4xl mb-3">⚙</span>
          <p className="text-sm font-medium">No jobs currently running</p>
        </div>
      )}
    </div>
  )
}

// ── Shell ──────────────────────────────────────────────────────────────────────

function Shell() {
  const [page, setPage] = useState<Page>('overview')
  const [dark, toggleDark] = useDarkMode()
  const { status } = useWebSocket()

  const connected = status === 'connected'

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        {/* Logo */}
        <div className="h-14 flex items-center gap-3 px-4 border-b border-gray-100 dark:border-gray-800">
          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
            <span className="text-white text-xs font-bold">TF</span>
          </div>
          <span className="font-bold text-gray-900 dark:text-white">Taskfire</span>
        </div>

        {/* Nav items */}
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV_ITEMS.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                page === id
                  ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
              }`}
            >
              <span className="text-base leading-none">{icon}</span>
              {label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-gray-100 dark:border-gray-800 space-y-2">
          {/* WS status */}
          <div className="flex items-center gap-2 px-1">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              connected ? 'bg-green-400' : status === 'reconnecting' ? 'bg-amber-400 animate-pulse' : 'bg-gray-300'
            }`} />
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {connected ? 'Live' : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
            </span>
          </div>
          {/* Dark mode */}
          <button
            onClick={toggleDark}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <span>{dark ? '☀' : '☾'}</span>
            {dark ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <h2 className="text-xl font-bold mb-6 text-gray-900 dark:text-white">
            {NAV_ITEMS.find((n) => n.id === page)?.label}
          </h2>

          {page === 'overview'    && <OverviewPage />}
          {page === 'jobs'        && <JobTable />}
          {page === 'deadletter'  && <DeadLetterPage />}
          {page === 'workers'     && <WorkersPage />}
        </div>
      </main>
    </div>
  )
}

// ── Root export ────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
