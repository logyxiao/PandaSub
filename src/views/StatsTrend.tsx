import { useMemo } from 'react'
import type { StatsGroup } from '../types'

export type StatsMetric = Exclude<keyof StatsGroup, 'period'>
const axisNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

export function StatsTrend({ rows, metric, label, unit, formatPeriod }: {
  rows: StatsGroup[]
  metric: StatsMetric
  label: string
  unit: string
  formatPeriod: (period: string) => string
}) {
  const series = useMemo(() => [...rows].sort((a, b) => a.period.localeCompare(b.period)).slice(-24), [rows])
  const peak = Math.max(0, ...series.map((row) => row[metric]))
  const ceiling = Math.max(4, Math.ceil(peak / 4) * 4)
  const tickEvery = Math.max(1, Math.ceil((series.length - 1) / 5))

  return (
    <section className={`panel stats-trend stats-tone-${metric}`} aria-label={`${label}趋势`}>
      <div className="stats-section-heading">
        <div><h2>{label}趋势</h2><span>{rows.length > 24 ? '最近 24 个有记录的周期' : `${rows.length} 个有记录的周期`} · 点击上方指标切换</span></div>
        <span className="stats-trend-peak">单期最高 <b>{peak.toLocaleString('zh-CN')}</b> {unit}</span>
      </div>
      <div className="stats-chart">
        <div className="stats-chart-axis" aria-hidden="true"><span>{axisNumber.format(ceiling)}</span><span>{axisNumber.format(ceiling / 2)}</span><span>0</span></div>
        <div className="stats-chart-columns" role="list" aria-label={`${label}各期数据`}>
          {series.map((row, index) => {
            const value = row[metric]
            const showTick = index % tickEvery === 0 || index === series.length - 1
            const date = row.period.length === 10 ? row.period.slice(5).replace('-', '/') : row.period.slice(2)
            return (
              <div key={row.period} className="stats-chart-column" role="listitem" tabIndex={0}
                aria-label={`${formatPeriod(row.period)}，${label} ${value} ${unit}`}>
                <div className="stats-chart-track">
                  <span className={`stats-chart-bar ${value === peak && peak > 0 ? 'is-peak' : ''}`} style={{ height: `${value / ceiling * 100}%` }} />
                  <span className={`stats-chart-tooltip ${index < series.length / 3 ? 'is-start' : index > series.length * 2 / 3 ? 'is-end' : ''}`} aria-hidden="true">
                    {formatPeriod(row.period)}<strong>{value.toLocaleString('zh-CN')} <small>{unit}{label}</small></strong>
                  </span>
                </div>
                <span className="stats-chart-tick" aria-hidden="true">{showTick ? date : '\u00a0'}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
