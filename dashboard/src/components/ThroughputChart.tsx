import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ThroughputPoint } from '../types/job'

export function ThroughputChart() {
  const [data, setData] = useState<ThroughputPoint[]>([])

  useEffect(() => {
    const load = async () => {
      try {
        const rows = await api.metrics.throughput()
        setData(
          rows.map((r) => ({
            ...r,
            time: new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          }))
        )
      } catch {
        // silently ignore while backend is starting
      }
    }
    load()
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">
        Throughput — jobs/min (last hour)
      </h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="completed" fill="#10b981" radius={[3, 3, 0, 0]} stackId="a" />
          <Bar dataKey="failed"    fill="#ef4444" radius={[3, 3, 0, 0]} stackId="a" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
