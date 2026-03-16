import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { useEffect, useState } from 'react'
import type { LiveMetrics } from '../types/job'
import type { TooltipProps } from 'recharts'

// ── Types ──────────────────────────────────────────────────────────────────────

interface DepthPoint {
  time:    string
  high:    number
  medium:  number
  low:     number
  delayed: number
}

interface Props {
  liveMetrics: LiveMetrics | null
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function DepthTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-gray-600 dark:text-gray-300 mb-1.5">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="capitalize text-gray-600 dark:text-gray-400">{entry.dataKey}</span>
          </span>
          <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
            {entry.value}
          </span>
        </div>
      ))}
      <div className="border-t border-gray-100 dark:border-gray-700 mt-1.5 pt-1.5 flex justify-between">
        <span className="text-gray-500 dark:text-gray-400">total</span>
        <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
          {payload.reduce((sum, e) => sum + (e.value ?? 0), 0)}
        </span>
      </div>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function QueueDepthChart({ liveMetrics }: Props) {
  const [history, setHistory] = useState<DepthPoint[]>([])

  useEffect(() => {
    if (!liveMetrics) return
    setHistory((prev) => {
      const point: DepthPoint = {
        time:    new Date(liveMetrics.timestamp).toLocaleTimeString([], {
          hour:   '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        high:    liveMetrics.queue_depth.high,
        medium:  liveMetrics.queue_depth.medium,
        low:     liveMetrics.queue_depth.low,
        delayed: liveMetrics.queue_depth.delayed,
      }
      return [...prev, point].slice(-60)
    })
  }, [liveMetrics])

  const isEmpty = history.length === 0

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Queue Depth (live)</h3>
        <span className="text-xs text-gray-400 dark:text-gray-500">last 60 ticks</span>
      </div>

      {isEmpty ? (
        <div className="flex items-center justify-center h-48 text-xs text-gray-400 dark:text-gray-600">
          Waiting for data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="highGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0}    />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(156,163,175,0.2)" />
            <XAxis
              dataKey="time"
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
            <Tooltip content={<DepthTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(v) => <span className="capitalize text-gray-600 dark:text-gray-400">{v}</span>}
            />
            <Line
              type="monotone"
              dataKey="high"
              stroke="#ef4444"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="medium"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="low"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="delayed"
              stroke="#8b5cf6"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              activeDot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
