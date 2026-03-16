import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { FailureRatePoint } from '../types/job'

export function FailureRateChart() {
  const [data, setData] = useState<(FailureRatePoint & { timeLabel: string })[]>([])

  useEffect(() => {
    const load = async () => {
      try {
        const rows = await api.metrics.failureRate()
        setData(
          rows.map((r) => ({
            ...r,
            timeLabel: new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          }))
        )
      } catch {
        // silently ignore
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  const formatPct = (v: number) => `${(v * 100).toFixed(1)}%`

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">Failure Rate (last hour)</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="timeLabel" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={formatPct} domain={[0, 1]} />
          <Tooltip formatter={(v: number) => formatPct(v)} />
          <Line
            type="monotone"
            dataKey="rate"
            stroke="#ef4444"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
