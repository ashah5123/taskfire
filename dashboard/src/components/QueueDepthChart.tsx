import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useEffect, useState } from 'react'
import type { LiveMetrics } from '../types/job'

interface Props {
  liveMetrics: LiveMetrics | null
}

export function QueueDepthChart({ liveMetrics }: Props) {
  const [history, setHistory] = useState<{ time: string; depth: number }[]>([])

  useEffect(() => {
    if (!liveMetrics) return
    setHistory((prev) => {
      const next = [
        ...prev,
        {
          time: new Date(liveMetrics.timestamp).toLocaleTimeString(),
          depth: liveMetrics.queue_depth.total,
        },
      ].slice(-60) // keep 60 data points (2 min at 2s intervals)
      return next
    })
  }, [liveMetrics])

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-4">Queue Depth (live)</h3>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={history}>
          <defs>
            <linearGradient id="depthGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
          <Tooltip />
          <Area
            type="monotone"
            dataKey="depth"
            stroke="#3b82f6"
            fill="url(#depthGrad)"
            strokeWidth={2}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
