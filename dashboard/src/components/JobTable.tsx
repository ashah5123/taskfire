import { useState, useCallback } from 'react'
import { useJobs, useJobLogs } from '../hooks/useJobs'
import type { Job, JobStatus, JobPriority } from '../types/job'

// ── Badge style maps ──────────────────────────────────────────────────────────

const STATUS_BADGE: Record<JobStatus, string> = {
  pending:   'bg-amber-100  text-amber-800  dark:bg-amber-900/40  dark:text-amber-300',
  active:    'bg-blue-100   text-blue-800   dark:bg-blue-900/40   dark:text-blue-300',
  completed: 'bg-green-100  text-green-800  dark:bg-green-900/40  dark:text-green-300',
  failed:    'bg-red-100    text-red-800    dark:bg-red-900/40    dark:text-red-300',
  dead:      'bg-gray-200   text-gray-700   dark:bg-gray-700/60   dark:text-gray-300',
}

const PRIORITY_BADGE: Record<JobPriority, string> = {
  high:   'bg-red-100    text-red-700    dark:bg-red-900/40    dark:text-red-300',
  medium: 'bg-amber-100  text-amber-700  dark:bg-amber-900/40  dark:text-amber-300',
  low:    'bg-gray-100   text-gray-600   dark:bg-gray-700/40   dark:text-gray-400',
}

const STATUS_LABELS: JobStatus[] = ['pending', 'active', 'completed', 'failed', 'dead']
const PRIORITY_LABELS: JobPriority[] = ['high', 'medium', 'low']

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts: string | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtDuration(job: Job): string {
  if (job.started_at && job.completed_at) {
    const ms = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
    if (ms < 1_000)   return `${ms}ms`
    if (ms < 60_000)  return `${(ms / 1_000).toFixed(2)}s`
    return `${(ms / 60_000).toFixed(1)}m`
  }
  if (job.started_at && job.status === 'active') {
    const ms = Date.now() - new Date(job.started_at).getTime()
    if (ms < 1_000)  return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s ↺`
    return `${(ms / 60_000).toFixed(1)}m ↺`
  }
  return '—'
}

function truncate(s: string, n = 8): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

// ── Expanded row sub-component ────────────────────────────────────────────────

function ExpandedRow({ job, colSpan }: { job: Job; colSpan: number }) {
  const { data: logsData, isLoading: logsLoading } = useJobLogs(job.id)

  return (
    <tr className="animate-slide-down">
      <td colSpan={colSpan} className="px-0 py-0">
        <div className="mx-4 mb-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">

          {/* Left: identifiers + timestamps */}
          <div className="space-y-2">
            <div>
              <span className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Job ID</span>
              <p className="font-mono text-gray-800 dark:text-gray-200 break-all mt-0.5">{job.id}</p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span className="text-gray-500 dark:text-gray-400">Created</span>
              <span className="text-gray-700 dark:text-gray-300">{fmtDate(job.created_at)}</span>
              <span className="text-gray-500 dark:text-gray-400">Started</span>
              <span className="text-gray-700 dark:text-gray-300">{fmtDate(job.started_at)}</span>
              <span className="text-gray-500 dark:text-gray-400">Completed</span>
              <span className="text-gray-700 dark:text-gray-300">{fmtDate(job.completed_at)}</span>
              <span className="text-gray-500 dark:text-gray-400">Failed at</span>
              <span className="text-gray-700 dark:text-gray-300">{fmtDate(job.failed_at)}</span>
              {job.scheduled_at && <>
                <span className="text-gray-500 dark:text-gray-400">Scheduled</span>
                <span className="text-gray-700 dark:text-gray-300">{fmtDate(job.scheduled_at)}</span>
              </>}
            </div>
            {job.dependencies.length > 0 && (
              <div>
                <span className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Dependencies ({job.dependencies.length})
                </span>
                <ul className="mt-0.5 space-y-0.5">
                  {job.dependencies.map((d) => (
                    <li key={d} className="font-mono text-gray-700 dark:text-gray-300">{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {job.error && (
              <div>
                <span className="font-semibold text-red-600 dark:text-red-400 uppercase tracking-wider">Error</span>
                <p className="mt-0.5 text-red-700 dark:text-red-300 whitespace-pre-wrap break-words">{job.error}</p>
              </div>
            )}
          </div>

          {/* Right: payload + logs */}
          <div className="space-y-3">
            <div>
              <span className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Payload</span>
              <pre className="mt-0.5 bg-gray-100 dark:bg-gray-800 rounded p-2 overflow-auto max-h-36 text-gray-800 dark:text-gray-200 font-mono leading-relaxed">
                {JSON.stringify(job.payload, null, 2)}
              </pre>
            </div>

            <div>
              <span className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Execution Log</span>
              {logsLoading ? (
                <p className="text-gray-400 mt-1">Loading…</p>
              ) : logsData && logsData.logs.length > 0 ? (
                <ol className="mt-1 space-y-0.5 border-l-2 border-gray-300 dark:border-gray-600 pl-3">
                  {logsData.logs.map((log, i) => (
                    <li key={i} className="relative">
                      <span className="absolute -left-4 top-0.5 w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500 border-2 border-white dark:border-gray-900" />
                      <span className="font-semibold text-gray-700 dark:text-gray-300 capitalize">{log.event}</span>
                      <span className="text-gray-400 ml-2">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      {log.detail && <p className="text-gray-600 dark:text-gray-400">{log.detail}</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-gray-400 mt-1">No log entries yet.</p>
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

interface Filters {
  status:   JobStatus | ''
  priority: JobPriority | ''
  type:     string
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const hasActive = filters.status !== '' || filters.priority !== '' || filters.type !== ''

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
      {/* Status filter */}
      <select
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value as JobStatus | '' })}
        className="text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-1.5 pr-6 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
      >
        <option value="">All statuses</option>
        {STATUS_LABELS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>

      {/* Priority filter */}
      <select
        value={filters.priority}
        onChange={(e) => onChange({ ...filters, priority: e.target.value as JobPriority | '' })}
        className="text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-1.5 pr-6 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
      >
        <option value="">All priorities</option>
        {PRIORITY_LABELS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>

      {/* Type filter */}
      <input
        type="text"
        placeholder="Filter by type…"
        value={filters.type}
        onChange={(e) => onChange({ ...filters, type: e.target.value })}
        className="text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-1.5 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none w-40"
      />

      {hasActive && (
        <button
          onClick={() => onChange({ status: '', priority: '', type: '' })}
          className="text-xs px-2 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function JobTable() {
  const [filters, setFilters] = useState<Filters>({ status: '', priority: '', type: '' })
  const [page,       setPage]       = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [pendingOp,  setPendingOp]  = useState<Record<string, 'cancel' | 'retry'>>({})

  const { jobs, total, pages, isLoading, isFetching, cancelJob, retryJob } = useJobs({
    status:   filters.status   || undefined,
    priority: filters.priority || undefined,
    type:     filters.type     || undefined,
    page,
    limit: 25,
  })

  const handleFilterChange = useCallback((f: Filters) => {
    setFilters(f)
    setPage(1)
    setExpandedId(null)
  }, [])

  const handleRowClick = useCallback((id: string) => {
    setExpandedId((prev) => prev === id ? null : id)
  }, [])

  const handleCancel = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setPendingOp((prev) => ({ ...prev, [id]: 'cancel' }))
    try { await cancelJob(id) }
    finally { setPendingOp((prev) => { const n = { ...prev }; delete n[id]; return n }) }
  }, [cancelJob])

  const handleRetry = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setPendingOp((prev) => ({ ...prev, [id]: 'retry' }))
    try { await retryJob(id) }
    finally { setPendingOp((prev) => { const n = { ...prev }; delete n[id]; return n }) }
  }, [retryJob])

  const COLS = 8

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">

      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Jobs</h3>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {total.toLocaleString()} total
          </span>
        </div>
        {isFetching && !isLoading && (
          <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25"/>
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4"/>
            </svg>
            Refreshing
          </span>
        )}
      </div>

      <FilterBar filters={filters} onChange={handleFilterChange} />

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/60 text-xs uppercase text-gray-500 dark:text-gray-400 sticky top-0">
            <tr>
              <th className="px-4 py-3 text-left font-medium">ID</th>
              <th className="px-4 py-3 text-left font-medium">Type</th>
              <th className="px-4 py-3 text-left font-medium">Priority</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Retries</th>
              <th className="px-4 py-3 text-left font-medium">Created</th>
              <th className="px-4 py-3 text-left font-medium">Duration</th>
              <th className="px-4 py-3 text-left font-medium">Actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {isLoading && (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: COLS }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" style={{ width: `${50 + (j * 13) % 40}%` }} />
                    </td>
                  ))}
                </tr>
              ))
            )}

            {!isLoading && jobs.map((job) => (
              <>
                <tr
                  key={job.id}
                  onClick={() => handleRowClick(job.id)}
                  className={`
                    cursor-pointer transition-colors select-none
                    ${expandedId === job.id
                      ? 'bg-blue-50 dark:bg-blue-950/30'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800/40'}
                  `}
                >
                  {/* ID */}
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                      {truncate(job.id)}
                    </span>
                  </td>

                  {/* Type */}
                  <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-200">
                    {job.type}
                  </td>

                  {/* Priority badge */}
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_BADGE[job.priority_label]}`}>
                      {job.priority_label}
                    </span>
                  </td>

                  {/* Status badge */}
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[job.status]}`}>
                      {job.status}
                    </span>
                  </td>

                  {/* Retries */}
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 tabular-nums">
                    {job.retry_count}
                    <span className="text-gray-400 dark:text-gray-500">/{job.max_retries}</span>
                  </td>

                  {/* Created */}
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {fmtDate(job.created_at)}
                  </td>

                  {/* Duration */}
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap">
                    {fmtDuration(job)}
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-1.5">
                      {(job.status === 'failed' || job.status === 'dead') && (
                        <button
                          disabled={Boolean(pendingOp[job.id])}
                          onClick={(e) => void handleRetry(e, job.id)}
                          className="text-xs px-2 py-1 rounded-md bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                        >
                          {pendingOp[job.id] === 'retry' ? '…' : 'Retry'}
                        </button>
                      )}
                      {job.status === 'pending' && (
                        <button
                          disabled={Boolean(pendingOp[job.id])}
                          onClick={(e) => void handleCancel(e, job.id)}
                          className="text-xs px-2 py-1 rounded-md bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                        >
                          {pendingOp[job.id] === 'cancel' ? '…' : 'Cancel'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>

                {expandedId === job.id && <ExpandedRow key={`${job.id}-exp`} job={job} colSpan={COLS} />}
              </>
            ))}

            {!isLoading && jobs.length === 0 && (
              <tr>
                <td colSpan={COLS} className="px-4 py-12 text-center text-gray-400 dark:text-gray-500 text-sm">
                  No jobs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-gray-800">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Page {page} of {pages} · {total.toLocaleString()} jobs
          </span>
          <div className="flex gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ← Prev
            </button>
            {/* Page numbers: show up to 5 around current */}
            {Array.from({ length: Math.min(pages, 5) }, (_, i) => {
              const p = Math.max(1, Math.min(page - 2, pages - 4)) + i
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`px-3 py-1 text-xs rounded-lg border transition-colors ${
                    p === page
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  {p}
                </button>
              )
            })}
            <button
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
