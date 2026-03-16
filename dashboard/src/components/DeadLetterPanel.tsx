import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { DLQEntry } from '../types/job'

// ── Constants ──────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], {
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  })
}

function priorityBadge(label: DLQEntry['priority_label']): string {
  switch (label) {
    case 'high':   return 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300'
    case 'medium': return 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
    case 'low':    return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
  }
}

// ── Row component ──────────────────────────────────────────────────────────────

interface RowProps {
  entry:      DLQEntry
  onRetry:    (id: string) => void
  isRetrying: boolean
}

function DLQRow({ entry, onRetry, isRetrying }: RowProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr
        className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {entry.id.slice(0, 8)}…
        </td>
        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
          {entry.type}
        </td>
        <td className="px-4 py-3">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${priorityBadge(entry.priority_label)}`}>
            {entry.priority_label}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-red-600 dark:text-red-400 font-mono max-w-xs truncate">
          {entry.error ?? '—'}
        </td>
        <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
          {entry.retry_count} / {entry.max_retries}
        </td>
        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {fmtDate(entry.failed_at)}
        </td>
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onRetry(entry.id)}
            disabled={isRetrying}
            className="px-2.5 py-1 rounded text-xs font-semibold bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isRetrying ? '…' : 'Retry'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50 dark:bg-gray-800/50">
          <td colSpan={7} className="px-6 py-3">
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1">
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block">Full ID</span>
                  <span className="font-mono text-gray-800 dark:text-gray-200 break-all">{entry.id}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block">Created</span>
                  <span className="text-gray-800 dark:text-gray-200">{fmtDate(entry.created_at)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block">Failed at</span>
                  <span className="text-gray-800 dark:text-gray-200">{fmtDate(entry.failed_at)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block">Priority value</span>
                  <span className="font-mono text-gray-800 dark:text-gray-200">{entry.priority}</span>
                </div>
              </div>
              {Object.keys(entry.payload).length > 0 && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block mb-1">Payload</span>
                  <pre className="bg-gray-100 dark:bg-gray-900 rounded p-2 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto">
                    {JSON.stringify(entry.payload, null, 2)}
                  </pre>
                </div>
              )}
              {entry.error && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block mb-1">Error</span>
                  <p className="font-mono text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded p-2 break-all">
                    {entry.error}
                  </p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-green-50 dark:bg-green-950/30 flex items-center justify-center mb-4">
        <span className="text-3xl">✓</span>
      </div>
      <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
        Dead-letter queue is empty
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
        All jobs have been processed successfully
      </p>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DeadLetterPanel() {
  const [offset, setOffset]           = useState(0)
  const [retryingAll, setRetryingAll] = useState(false)
  const [retryingId, setRetryingId]   = useState<string | null>(null)
  const queryClient                   = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey:        ['dlq', offset],
    queryFn:         () => api.metrics.deadLetter({ limit: PAGE_SIZE, offset }),
    refetchInterval: 15_000,
    staleTime:       5_000,
  })

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.jobs.retry(id, { reset_retries: true }),
    onSuccess:  () => void queryClient.invalidateQueries({ queryKey: ['dlq'] }),
  })

  const handleRetry = useCallback(async (id: string) => {
    setRetryingId(id)
    try {
      await retryMutation.mutateAsync(id)
    } finally {
      setRetryingId(null)
    }
  }, [retryMutation])

  const handleRetryAll = useCallback(async () => {
    if (!data?.jobs.length) return
    setRetryingAll(true)
    try {
      await Promise.allSettled(data.jobs.map((j) => retryMutation.mutateAsync(j.id)))
      await refetch()
    } finally {
      setRetryingAll(false)
    }
  }, [data, retryMutation, refetch])

  const total    = data?.total   ?? 0
  const jobs     = data?.jobs    ?? []
  const pages    = Math.ceil(total / PAGE_SIZE)
  const page     = Math.floor(offset / PAGE_SIZE) + 1
  const hasPages = pages > 1

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
        <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load dead-letter queue.{' '}
          <button onClick={() => refetch()} className="underline font-medium">
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Dead-Letter Queue</h3>
          {total > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300">
              {total}
            </span>
          )}
        </div>
        {jobs.length > 0 && (
          <button
            onClick={handleRetryAll}
            disabled={retryingAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white transition-colors"
          >
            {retryingAll ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Retrying…
              </>
            ) : (
              <>↺ Retry all ({jobs.length})</>
            )}
          </button>
        )}
      </div>

      {/* Content */}
      {jobs.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">Job ID</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Priority</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Failure reason</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">Retries</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">Last failed</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {jobs.map((entry) => (
                  <DLQRow
                    key={entry.id}
                    entry={entry}
                    onRetry={handleRetry}
                    isRetrying={retryingId === entry.id}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {hasPages && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-gray-800">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-1">
                <button
                  disabled={page === 1}
                  onClick={() => setOffset((o) => Math.max(o - PAGE_SIZE, 0))}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ← Prev
                </button>
                {Array.from({ length: Math.min(pages, 5) }).map((_, i) => {
                  const p = i + 1
                  return (
                    <button
                      key={p}
                      onClick={() => setOffset((p - 1) * PAGE_SIZE)}
                      className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                        p === page
                          ? 'bg-blue-600 text-white'
                          : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      {p}
                    </button>
                  )
                })}
                <button
                  disabled={page === pages}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
