import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { QueueMetrics } from '../types/job'
import type { TooltipProps } from 'recharts'

// ── Types ──────────────────────────────────────────────────────────────────────

interface DataPoint {
  time:        string
  failureRate: number   // 0–100
  dlqDepth:    number
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function FailureTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const rate  = payload.find((p) => p.dataKey === 'failureRate')?.value ?? 0
  const dlq   = payload.find((p) => p.dataKey === 'dlqDepth')?.value   ?? 0
  const above = Number(rate) > 5

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-gray-600 dark:text-gray-300 mb-1.5">{label}</p>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm bg-red-400" />
            <span className="text-gray-600 dark:text-gray-400">Failure rate</span>
          </span>
          <span className={`font-mono font-semibold ${
            above ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'
          }`}>
            {Number(rate).toFixed(1)}%
            {above && ' ⚠'}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm bg-orange-400" />
            <span className="text-gray-600 dark:text-gray-400">DLQ depth</span>
          </span>
          <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">{dlq}</span>
        </div>
      </div>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function FailureRateChart() {
  const [data,    setData]    = useState<DataPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  const load = useCallback(async () => {
    try {
      const summary: QueueMetrics = await api.metrics.summary()
      const point: DataPoint = {
        time:        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        failureRate: summary.failure_rate * 100,
        dlqDepth:    summary.dlq_depth,
      }
      setData((prev) => [...prev, point].slice(-60))
      setError(false)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [load])

  const latest      = data[data.length - 1]
  const currentRate = latest?.failureRate ?? 0
  const isAlert     = currentRate > 5

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Failure Rate
          </h3>
          {isAlert && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 animate-pulse">
              ⚠ above 5%
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          {!loading && (
            <>
              <span>
                Rate:{' '}
                <span className={`font-mono font-semibold ${isAlert ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>
                  {currentRate.toFixed(1)}%
                </span>
              </span>
              <span>
                DLQ:{' '}
                <span className="font-mono font-semibold text-orange-600 dark:text-orange-400">
                  {latest?.dlqDepth ?? 0}
                </span>
              </span>
            </>
          )}
          {loading && <span>Loading…</span>}
          {error && !loading && (
            <button onClick={load} className="text-blue-600 dark:text-blue-400 hover:underline">
              Retry
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 text-xs text-gray-400 dark:text-gray-600">
          Loading metrics…
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-48 text-xs text-red-400 dark:text-red-500">
          Failed to load — backend may be starting up
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="failGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#f87171" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#f87171" stopOpacity={0}   />
              </linearGradient>
              <linearGradient id="dlqGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#fb923c" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#fb923c" stopOpacity={0}    />
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
            {/* Left Y-axis for failure rate (0–100%) */}
            <YAxis
              yAxisId="rate"
              domain={[0, Math.max(100, Math.ceil(currentRate * 1.4))]}
              tick={{ fontSize: 9, fill: 'currentColor' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}%`}
              width={36}
            />
            {/* Right Y-axis for DLQ depth */}
            <YAxis
              yAxisId="dlq"
              orientation="right"
              allowDecimals={false}
              tick={{ fontSize: 9, fill: 'currentColor' }}
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <Tooltip content={<FailureTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(v) => (
                <span className="text-gray-600 dark:text-gray-400">
                  {v === 'failureRate' ? 'Failure rate (%)' : 'DLQ depth'}
                </span>
              )}
            />
            {/* 5% threshold reference line */}
            <ReferenceLine
              yAxisId="rate"
              y={5}
              stroke="#dc2626"
              strokeDasharray="6 3"
              strokeWidth={1.5}
              label={{
                value:    '5% threshold',
                position: 'insideTopRight',
                fontSize: 9,
                fill:     '#dc2626',
              }}
            />
            {/* Failure rate area */}
            <Area
              yAxisId="rate"
              type="monotone"
              dataKey="failureRate"
              stroke="#f87171"
              fill="url(#failGrad)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
            />
            {/* DLQ depth area */}
            <Area
              yAxisId="dlq"
              type="monotone"
              dataKey="dlqDepth"
              stroke="#fb923c"
              fill="url(#dlqGrad)"
              strokeWidth={1.5}
              strokeDasharray="5 2"
              dot={false}
              activeDot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
