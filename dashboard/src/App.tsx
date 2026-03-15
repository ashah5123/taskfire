import { useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { useJobs } from './hooks/useJobs'
import { MetricCard } from './components/MetricCard'
import { QueueDepthChart } from './components/QueueDepthChart'
import { ThroughputChart } from './components/ThroughputChart'
import { FailureRateChart } from './components/FailureRateChart'
import { WorkerUtilization } from './components/WorkerUtilization'
import { JobTable } from './components/JobTable'

const STATUS_FILTERS = ['all', 'pending', 'active', 'completed', 'failed', 'dead'] as const

export default function App() {
  const { metrics, connected } = useWebSocket()
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [page, setPage] = useState(1)
  const { jobs, total, loading, retry, cancel } = useJobs({
    status: statusFilter === 'all' ? undefined : statusFilter,
    page,
    limit: 20,
  })

  const totalPages = Math.ceil(total / 20)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <span className="text-white text-xs font-bold">TF</span>
          </div>
          <h1 className="text-lg font-bold text-gray-900">Taskfire</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-300'}`} />
          <span className="text-xs text-gray-500">{connected ? 'Live' : 'Connecting…'}</span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Metric Cards */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            title="Queue Depth"
            value={metrics?.queue_depth ?? '—'}
            color="blue"
          />
          <MetricCard
            title="Active Jobs"
            value={metrics?.active_jobs ?? '—'}
            color="green"
          />
          <MetricCard
            title="DLQ Depth"
            value={metrics?.dlq_depth ?? '—'}
            color="red"
          />
          <MetricCard
            title="Total Jobs"
            value={total}
            color="purple"
          />
        </section>

        {/* Charts row */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <QueueDepthChart liveMetrics={metrics} />
          <WorkerUtilization liveMetrics={metrics} />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ThroughputChart />
          <FailureRateChart />
        </section>

        {/* Job Table */}
        <section>
          {/* Filter tabs */}
          <div className="flex gap-1 mb-4">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setPage(1) }}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 border border-gray-200 hover:border-blue-300'
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          <JobTable jobs={jobs} loading={loading} onRetry={retry} onCancel={cancel} />

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-4">
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 rounded border text-sm disabled:opacity-40"
              >
                Prev
              </button>
              <span className="px-3 py-1 text-sm text-gray-500">
                {page} / {totalPages}
              </span>
              <button
                disabled={page === totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 rounded border text-sm disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
