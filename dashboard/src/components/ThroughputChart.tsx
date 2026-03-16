import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { useEffect, useState, useCallback } from 'react'
import { api } from '../api/client'
import type { ThroughputPoint } from '../types/job'
import type { TooltipProps } from 'recharts'

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChartPoint extends ThroughputPoint {
  timeLabel: string
  total:     number
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function ThroughputTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const completed = payload.find((p) => p.dataKey === 'completed')?.value ?? 0
  const failed    = payload.find((p) => p.dataKey === 'failed')?.value    ?? 0
  const total     = completed + failed
  const failRate  = total > 0 ? ((failed / total) * 100).toFixed(1) : '0.0'

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-gray-600 dark:text-gray-300 mb-1.5">{label}</p>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" />
            <span className="text-gray-600 dark:text-gray-400">Completed</span>
          </span>
          <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">{completed}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm bg-red-500" />
            <span className="text-gray-600 dark:text-gray-400">Failed</span>
          </span>
          <span className="font-mono font-semibold text-red-600 dark:text-red-400">{failed}</span>
        </div>
      </div>
      <div className="border-t border-gray-100 dark:border-gray-700 mt-1.5 pt-1.5 space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="text-gray-500 dark:text-gray-400">Total</span>
          <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">{total}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-gray-500 dark:text-gray-400">Failure rate</span>
          <span className={`font-mono font-semibold ${
            Number(failRate) > 5 ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'
          }`}>
            {failRate}%
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Custom legend ──────────────────────────────────────────────────────────────

function ThroughputLegend({ totalCompleted, totalFailed }: { totalCompleted: number; totalFailed: number }) {
  return (
    <div className="flex items-center justify-end gap-4 mt-1 px-1">
      <span className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" />
        Completed
        <span className="font-mono font-semibold text-gray-900 dark:text-gray-100 ml-0.5">
          {totalCompleted.toLocaleString()}
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500" />
        Failed
        <span className="font-mono font-semibold text-red-600 dark:text-red-400 ml-0.5">
          {totalFailed.toLocaleString()}
        </span>
      </span>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ThroughputChart() {
  const [data,    setData]    = useState<ChartPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  const load = useCallback(async () => {
    try {
      const rows = await api.metrics.throughput()
      setData(
        rows.map((r) => ({
          ...r,
          timeLabel: new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          total:     r.completed + r.failed,
        }))
      )
      setError(false)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const totalCompleted = data.reduce((s, r) => s + r.completed, 0)
  const totalFailed    = data.reduce((s, r) => s + r.failed,    0)

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Throughput — jobs/min (last hour)
        </h3>
        {loading && (
          <span className="text-xs text-gray-400 dark:text-gray-500">Loading…</span>
        )}
        {error && !loading && (
          <button
            onClick={load}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Retry
          </button>
        )}
      </div>

      <ThroughputLegend totalCompleted={totalCompleted} totalFailed={totalFailed} />

      {loading ? (
        <div className="flex items-center justify-center h-48 text-xs text-gray-400 dark:text-gray-600">
          Loading throughput data…
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-48 text-xs text-red-400 dark:text-red-500">
          Failed to load — backend may be starting up
        </div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-xs text-gray-400 dark:text-gray-600">
          No throughput data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(156,163,175,0.2)" />
            <XAxis
              dataKey="timeLabel"
              tick={{ fontSize: 9, fill: 'currentColor' }}
              interval="preserveStartEnd"
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 9, fill: 'currentColor' }}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <Tooltip content={<ThroughputTooltip />} cursor={{ fill: 'rgba(156,163,175,0.1)' }} />
            <Bar dataKey="completed" stackId="t" fill="#10b981" radius={[0, 0, 0, 0]} maxBarSize={24}>
              {data.map((_, i) => (
                <Cell key={i} fill="#10b981" />
              ))}
            </Bar>
            <Bar dataKey="failed" stackId="t" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={24}>
              {data.map((_, i) => (
                <Cell key={i} fill="#ef4444" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
