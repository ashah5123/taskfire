import { useEffect, useRef, useState } from 'react'

// ── Animated counter ──────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 700): number {
  const [displayed, setDisplayed] = useState(target)
  const fromRef    = useRef(target)
  const rafRef     = useRef(0)

  useEffect(() => {
    const from = fromRef.current
    if (from === target) return

    const startTime = performance.now()

    const animate = (now: number) => {
      const elapsed  = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      // Cubic ease-out: decelerate toward the target value.
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplayed(Math.round(from + (target - from) * eased))

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate)
      } else {
        setDisplayed(target)
        fromRef.current = target
      }
    }

    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(animate)
    fromRef.current = target

    return () => cancelAnimationFrame(rafRef.current)
  }, [target, duration])

  return displayed
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ColorScheme = 'blue' | 'green' | 'red' | 'amber' | 'purple' | 'indigo'

interface MetricCardProps {
  label:           string
  value:           number
  previousValue?:  number
  higherIsBetter?: boolean
  formatter?:      (n: number) => string
  unit?:           string
  subtitle?:       string
  colorScheme?:    ColorScheme
}

// ── Style maps ────────────────────────────────────────────────────────────────

const cardStyles: Record<ColorScheme, string> = {
  blue:   'bg-blue-50   dark:bg-blue-950/40  border-blue-200   dark:border-blue-800',
  green:  'bg-green-50  dark:bg-green-950/40 border-green-200  dark:border-green-800',
  red:    'bg-red-50    dark:bg-red-950/40   border-red-200    dark:border-red-800',
  amber:  'bg-amber-50  dark:bg-amber-950/40 border-amber-200  dark:border-amber-800',
  purple: 'bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-800',
  indigo: 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800',
}

const labelStyles: Record<ColorScheme, string> = {
  blue:   'text-blue-600   dark:text-blue-400',
  green:  'text-green-600  dark:text-green-400',
  red:    'text-red-600    dark:text-red-400',
  amber:  'text-amber-600  dark:text-amber-400',
  purple: 'text-purple-600 dark:text-purple-400',
  indigo: 'text-indigo-600 dark:text-indigo-400',
}

const valueStyles: Record<ColorScheme, string> = {
  blue:   'text-blue-900   dark:text-blue-100',
  green:  'text-green-900  dark:text-green-100',
  red:    'text-red-900    dark:text-red-100',
  amber:  'text-amber-900  dark:text-amber-100',
  purple: 'text-purple-900 dark:text-purple-100',
  indigo: 'text-indigo-900 dark:text-indigo-100',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MetricCard({
  label,
  value,
  previousValue,
  higherIsBetter = true,
  formatter,
  unit,
  subtitle,
  colorScheme = 'blue',
}: MetricCardProps) {
  const displayed = useCountUp(value)

  const formattedValue = formatter ? formatter(displayed) : displayed.toLocaleString()

  // Percentage change relative to previous period.
  const pctChange =
    previousValue !== undefined && previousValue !== 0
      ? ((value - previousValue) / Math.abs(previousValue)) * 100
      : null

  // An "improvement" means the metric moved in the desired direction.
  const isImprovement =
    pctChange !== null
      ? higherIsBetter ? pctChange > 0 : pctChange < 0
      : null

  const trendClass =
    isImprovement === null
      ? 'text-gray-400 dark:text-gray-500'
      : isImprovement
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400'

  const trendIcon =
    pctChange === null      ? null
    : pctChange > 0         ? '▲'
    : pctChange < 0         ? '▼'
    : '→'

  return (
    <div
      className={`
        rounded-xl border-2 p-5 flex flex-col gap-1 transition-shadow
        hover:shadow-md ${cardStyles[colorScheme]}
      `}
    >
      <p className={`text-xs font-semibold uppercase tracking-wider ${labelStyles[colorScheme]}`}>
        {label}
      </p>

      <div className="flex items-end gap-2 mt-1">
        <p className={`text-3xl font-bold tabular-nums ${valueStyles[colorScheme]}`}>
          {formattedValue}
          {unit && <span className="text-base font-normal ml-1">{unit}</span>}
        </p>

        {pctChange !== null && trendIcon !== null && (
          <span className={`text-sm font-semibold mb-0.5 ${trendClass}`}>
            {trendIcon} {Math.abs(pctChange).toFixed(1)}%
          </span>
        )}
      </div>

      {subtitle && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{subtitle}</p>
      )}
    </div>
  )
}
