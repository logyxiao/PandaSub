import { useAsyncResource } from '../hooks/useAsyncResource'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { api } from '../api'
import { Button } from '../components/ui'

const localDate = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`

export function DashboardTrend() {
  const [revision, setRevision] = useState(0)
  useEffect(() => { const timer = window.setInterval(() => setRevision(value => value + 1), 60_000); return () => window.clearInterval(timer) }, [])
  const [days, setDays] = useState<7 | 30>(7)
  const gradient = useId()
  const dates = useMemo(() => {
    const today = new Date()
    return Array.from({ length: days }, (_, index) => {
      const date = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() - days + index + 1,
      )
      return localDate(date)
    })
  }, [days, revision]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTrend = useCallback((refresh = false) => api.getStats(dates[0], dates[dates.length - 1], 'day', refresh), [dates])
  const { data, loading, error, reload } = useAsyncResource(fetchTrend)
  const rows = data?.groups ?? []

  const series = dates.map(
    (period) =>
      rows.find((row) => row.period === period) ?? {
        period,
        deliveries: 0,
        human_replies: 0,
      },
  )
  const total = series.reduce((sum, row) => sum + row.deliveries, 0)
  const peak = Math.max(
    1,
    ...series.flatMap((row) => [row.deliveries, row.human_replies]),
  )
  const ceiling = Math.max(4, Math.ceil(peak / 4) * 4)
  const x = (index: number) => 34 + (index / (days - 1)) * 508
  const y = (value: number) => 130 - (value / ceiling) * 108
  const path = (key: 'deliveries' | 'human_replies') =>
    series
      .map((row, index) => `${index ? 'L' : 'M'}${x(index)},${y(row[key])}`)
      .join(' ')
  const ticks = [
    ...new Set([
      0,
      Math.floor((days - 1) / 3),
      Math.floor(((days - 1) * 2) / 3),
      days - 1,
    ]),
  ]

  return (
    <section className="panel dashboard-trend" aria-label="投递趋势">
      <div className="panel-heading">
        <h2>投递趋势</h2>
        <div
          className="dashboard-period"
          role="group"
          aria-label="趋势时间范围"
        >
          {([7, 30] as const).map((value) => (
            <button
              key={value}
              aria-pressed={days === value}
              onClick={() => setDays(value)}
            >
              近 {value} 天
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <div className="dashboard-chart-error" role="alert">
          <p>趋势暂时无法读取</p>
          <small>{error}</small>
          <Button size="sm" onClick={() => void reload()}>
            重试趋势
          </Button>
        </div>
      ) : (
        <>
          <div className="dashboard-chart-summary">
            <strong>
              {loading && !data ? '—' : total}
              <small>封投递</small>
            </strong>
            <div className="dashboard-chart-legend">
              <span>
                <i />
                投递
              </span>
              <span>
                <i />
                人工回复
              </span>
            </div>
          </div>
          {loading && !data ? (
            <p className="dashboard-empty">正在读取趋势…</p>
          ) : (
            <svg
              className="dashboard-chart"
              viewBox="0 0 560 154"
              role="img"
              aria-label={`近 ${days} 天成功投递 ${total} 封，人工回复 ${series.reduce((sum, row) => sum + row.human_replies, 0)} 封`}
            >
              <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--accent-mid)"
                    stopOpacity=".2"
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--accent-mid)"
                    stopOpacity=".02"
                  />
                </linearGradient>
              </defs>
              {[0, 1, 2, 3, 4].map((index) => (
                <g key={index}>
                  <line
                    x1="34"
                    x2="542"
                    y1={y((index * ceiling) / 4)}
                    y2={y((index * ceiling) / 4)}
                    stroke="var(--border)"
                    strokeDasharray="3 4"
                  />
                  <text
                    x="26"
                    y={y((index * ceiling) / 4) + 3}
                    textAnchor="end"
                  >
                    {(index * ceiling) / 4}
                  </text>
                </g>
              ))}
              <path
                d={`${path('deliveries')} L542,130 L34,130 Z`}
                fill={`url(#${gradient})`}
              />
              <path
                d={path('deliveries')}
                fill="none"
                stroke="var(--accent-mid)"
                strokeWidth="2"
              />
              <path
                d={path('human_replies')}
                fill="none"
                stroke="var(--chart-secondary)"
                strokeWidth="2"
              />
              {ticks.map((index) => (
                <text
                  key={index}
                  x={x(index)}
                  y="149"
                  textAnchor={
                    index === 0
                      ? 'start'
                      : index === days - 1
                        ? 'end'
                        : 'middle'
                  }
                >
                  {dates[index].slice(5).replace('-', '/')}
                </text>
              ))}
              {series.map((row, index) => (
                <circle
                  key={row.period}
                  cx={x(index)}
                  cy={y(row.deliveries)}
                  r={days === 7 ? 3 : 2}
                  fill="white"
                  stroke="var(--accent-mid)"
                >
                  <title>
                    {row.period}：投递 {row.deliveries} 封，人工回复{' '}
                    {row.human_replies} 封
                  </title>
                </circle>
              ))}
            </svg>
          )}
        </>
      )}
    </section>
  )
}
