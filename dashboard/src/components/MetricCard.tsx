interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'purple'
}

const colorMap = {
  blue: 'bg-blue-50 border-blue-200 text-blue-700',
  green: 'bg-green-50 border-green-200 text-green-700',
  red: 'bg-red-50 border-red-200 text-red-700',
  yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
  purple: 'bg-purple-50 border-purple-200 text-purple-700',
}

const trendIcon = { up: '↑', down: '↓', neutral: '→' }
const trendColor = { up: 'text-green-500', down: 'text-red-500', neutral: 'text-gray-400' }

export function MetricCard({ title, value, subtitle, trend, color = 'blue' }: MetricCardProps) {
  return (
    <div className={`rounded-xl border-2 p-5 ${colorMap[color]} flex flex-col gap-1`}>
      <p className="text-xs font-semibold uppercase tracking-wider opacity-70">{title}</p>
      <p className="text-3xl font-bold mt-1">
        {value}
        {trend && (
          <span className={`ml-2 text-base ${trendColor[trend]}`}>{trendIcon[trend]}</span>
        )}
      </p>
      {subtitle && <p className="text-xs opacity-60 mt-1">{subtitle}</p>}
    </div>
  )
}
