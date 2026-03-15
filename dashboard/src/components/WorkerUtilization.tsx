import { useEffect, useState } from 'react'
import type { LiveMetrics } from '../types/job'

interface Props {
  liveMetrics: LiveMetrics | null
  totalWorkers?: number
}

export function WorkerUtilization({ liveMetrics, totalWorkers = 10 }: Props) {
  const [history, setHistory] = useState<number[]>([])

  useEffect(() => {
    if (!liveMetrics) return
    const pct = Math.min((liveMetrics.active_jobs / totalWorkers) * 100, 100)
    setHistory((prev) => [...prev.slice(-19), pct])
  }, [liveMetrics, totalWorkers])

  const current = history[history.length - 1] ?? 0
  const color = current > 80 ? 'bg-red-500' : current > 50 ? 'bg-yellow-500' : 'bg-green-500'

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-600 mb-4">Worker Utilization</h3>
      <div className="flex items-end gap-1 h-20">
        {history.map((pct, i) => (
          <div
            key={i}
            className={`flex-1 rounded-t transition-all ${color}`}
            style={{ height: `${Math.max(pct, 2)}%` }}
            title={`${pct.toFixed(1)}%`}
          />
        ))}
        {history.length === 0 && (
          <p className="text-xs text-gray-400 m-auto">Waiting for data…</p>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {liveMetrics?.active_jobs ?? 0} / {totalWorkers} workers active ({current.toFixed(1)}%)
      </p>
    </div>
  )
}
