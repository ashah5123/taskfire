import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { LiveMetrics } from '../types/job'
import type { TooltipProps } from 'recharts'

// ── Types ──────────────────────────────────────────────────────────────────────

interface WorkerSlot {
  id:            string
  utilization:   number
  status:        'busy' | 'idle'
  job_type:      string | null
  running_for_s: number
}

interface Props {
  liveMetrics:   LiveMetrics | null
  totalWorkers?: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function utilizationColor(pct: number): string {
  if (pct >= 90) return '#ef4444'
  if (pct >= 70) return '#f59e0b'
  return '#10b981'
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60)  return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function WorkerTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const slot = payload[0].payload as WorkerSlot
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-gray-700 dark:text-gray-300 mb-1">{slot.id}</p>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="text-gray-500 dark:text-gray-400">Status</span>
          <span className={`font-semibold ${
            slot.status === 'busy'
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-gray-400 dark:text-gray-600'
          }`}>
            {slot.status}
          </span>
        </div>
        {slot.job_type && (
          <div className="flex justify-between gap-4">
            <span className="text-gray-500 dark:text-gray-400">Job type</span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{slot.job_type}</span>
          </div>
        )}
        {slot.status === 'busy' && (
          <div className="flex justify-between gap-4">
            <span className="text-gray-500 dark:text-gray-400">Running</span>
            <span className="font-mono text-gray-900 dark:text-gray-100">
              {fmtDuration(slot.running_for_s * 1000)}
            </span>
          </div>
        )}
        <div className="flex justify-between gap-4 border-t border-gray-100 dark:border-gray-700 mt-1 pt-1">
          <span className="text-gray-500 dark:text-gray-400">Utilization</span>
          <span
            className="font-mono font-semibold"
            style={{ color: utilizationColor(slot.utilization) }}
          >
            {slot.utilization.toFixed(0)}%
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function WorkerUtilization({ liveMetrics, totalWorkers = 10 }: Props) {
  const { data: workerMetrics } = useQuery({
    queryKey:        ['workers'],
    queryFn:         () => api.metrics.workers(),
    refetchInterval: 5_000,
    staleTime:       3_000,
  })

  // Build worker slot list from active jobs + fill remaining idle slots.
  const activeJobs    = workerMetrics?.active_workers ?? liveMetrics?.active_jobs ?? 0
  const activeJobList = workerMetrics?.active_jobs ?? []

  const slots: WorkerSlot[] = activeJobList.map((job, i) => ({
    id:            `Worker ${i + 1}`,
    utilization:   100,
    status:        'busy',
    job_type:      job.job_type,
    running_for_s: Math.round(job.running_for_ms / 1000),
  }))

  const idleCount = Math.max(totalWorkers - slots.length, 0)
  for (let i = 0; i < idleCount; i++) {
    slots.push({
      id:            `Worker ${slots.length + 1}`,
      utilization:   0,
      status:        'idle',
      job_type:      null,
      running_for_s: 0,
    })
  }

  const utilPct    = Math.min((activeJobs / totalWorkers) * 100, 100)
  const poolColor  = utilizationColor(utilPct)
  const chartH     = Math.max(slots.length * 36 + 20, 180)

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Worker Utilization</h3>
        <div className="flex items-center gap-2 text-xs">
          <span
            className="font-mono font-bold"
            style={{ color: poolColor }}
          >
            {utilPct.toFixed(0)}%
          </span>
          <span className="text-gray-400 dark:text-gray-500">
            {activeJobs}/{totalWorkers} active
          </span>
        </div>
      </div>

      {/* Pool-level utilization bar */}
      <div className="mb-4">
        <div className="h-2 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${utilPct}%`, backgroundColor: poolColor }}
          />
        </div>
        <div className="flex justify-between mt-1 text-xs text-gray-400 dark:text-gray-600">
          <span>0%</span>
          <span className="text-amber-500">70%</span>
          <span className="text-red-500">90%</span>
          <span>100%</span>
        </div>
      </div>

      {/* Per-worker horizontal bars */}
      <ResponsiveContainer width="100%" height={chartH}>
        <BarChart
          data={slots}
          layout="vertical"
          margin={{ top: 0, right: 40, bottom: 0, left: 64 }}
          barCategoryGap="20%"
        >
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(156,163,175,0.15)" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tick={{ fontSize: 9, fill: 'currentColor' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v}%`}
          />
          <YAxis
            type="category"
            dataKey="id"
            tick={{ fontSize: 10, fill: 'currentColor' }}
            tickLine={false}
            axisLine={false}
            width={60}
          />
          <Tooltip content={<WorkerTooltip />} cursor={{ fill: 'rgba(156,163,175,0.08)' }} />
          <ReferenceLine x={70} stroke="#f59e0b" strokeDasharray="4 3" strokeWidth={1} />
          <ReferenceLine x={90} stroke="#ef4444" strokeDasharray="4 3" strokeWidth={1} />
          <Bar dataKey="utilization" radius={[0, 4, 4, 0]} maxBarSize={20}>
            {slots.map((slot, i) => (
              <Cell key={i} fill={utilizationColor(slot.utilization)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" />
          &lt; 70%
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-sm bg-amber-500" />
          70–90%
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-sm bg-red-500" />
          &gt; 90%
        </span>
      </div>
    </div>
  )
}
