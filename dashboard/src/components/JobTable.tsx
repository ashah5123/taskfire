import type { Job, JobStatus } from '../types/job'

interface Props {
  jobs: Job[]
  loading: boolean
  onRetry: (id: string) => void
  onCancel: (id: string) => void
}

const statusBadge: Record<JobStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  active: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  dead: 'bg-gray-200 text-gray-700',
}

function fmt(ts?: string) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export function JobTable({ jobs, loading, onRetry, onCancel }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-600">Jobs</h3>
        {loading && <span className="text-xs text-gray-400">Refreshing…</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">ID</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Priority</th>
              <th className="px-4 py-3 text-left">Retries</th>
              <th className="px-4 py-3 text-left">Created</th>
              <th className="px-4 py-3 text-left">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{job.id.slice(0, 8)}…</td>
                <td className="px-4 py-3 font-medium text-gray-800">{job.type}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge[job.status]}`}>
                    {job.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{job.priority}</td>
                <td className="px-4 py-3 text-gray-600">{job.retry_count}/{job.max_retries}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{fmt(job.created_at)}</td>
                <td className="px-4 py-3 flex gap-2">
                  {['failed', 'dead'].includes(job.status) && (
                    <button
                      onClick={() => onRetry(job.id)}
                      className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
                    >
                      Retry
                    </button>
                  )}
                  {['pending'].includes(job.status) && (
                    <button
                      onClick={() => onCancel(job.id)}
                      className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400 text-sm">
                  No jobs found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
