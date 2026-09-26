import { useAsyncResource } from '../hooks/useAsyncResource'
import { useCallback, useMemo, useState } from 'react'
import { Award, BarChart3, CalendarDays, CircleAlert, List, MessageSquare, RefreshCw, Send } from 'lucide-react'
import { api } from '../api'
import { EmptyState, IconButton, Select } from '../components/ui'
import { Table } from '../components/Table'
import { StatsTrend, type StatsMetric } from './StatsTrend'

type GroupMode = 'day' | 'week' | 'month'

const fmtDate = (d: Date) => {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function periodLabel(period: string, mode: GroupMode): string {
  if (mode === 'week') {
    // "2025-W05" → "2025 第 5 周"
    const m = /^(\d{4})-W(\d{2})$/.exec(period)
    return m ? `${m[1]} 第 ${Number(m[2])} 周` : period
  }
  if (mode === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(period)
    return m ? `${m[1]} 年 ${Number(m[2])} 月` : period
  }
  return period
}

export function StatsView() {
  const [group, setGroup] = useState<GroupMode>('day')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [metric, setMetric] = useState<StatsMetric>('deliveries')
  const [preset, setPreset] = useState<'7' | '30' | 'month' | 'all' | null>('all')
  const fetchReport = useCallback((refresh = false) => api.getStats(start || undefined, end || undefined, group, refresh), [start, end, group])
  const { data: report, loading, error: notice, reload } = useAsyncResource(fetchReport)

  const quick = (days: number | null) => {
    setPreset(days === null ? 'all' : days === 7 ? '7' : '30')
    const today = new Date()
    if (days === null) {
      setStart(''); setEnd('')
      return
    }
    setEnd(fmtDate(today))
    const from = new Date(today)
    from.setDate(from.getDate() - (days - 1))
    setStart(fmtDate(from))
  }

  const quickMonth = () => {
    setPreset('month')
    const today = new Date()
    setEnd(fmtDate(today))
    setStart(fmtDate(new Date(today.getFullYear(), today.getMonth(), 1)))
  }

  const maxDeliveries = useMemo(() => {
    if (!report?.groups.length) return 0
    return report.groups.reduce((max, row) => Math.max(max, row.deliveries), 1)
  }, [report])

  const totals = report?.totals
  const cards = [
    { key: 'deliveries', label: '投递次数', value: totals?.deliveries ?? 0, icon: Send, unit: '封', note: '成功发出的投稿邮件' },
    { key: 'human_replies', label: '人工回复', value: totals?.human_replies ?? 0, icon: MessageSquare, unit: '封', note: '识别为人工回复的来信' },
    { key: 'accepted', label: '过稿回复', value: totals?.accepted ?? 0, icon: Award, unit: '封', note: '标记为过稿的来信' },
    { key: 'failures', label: '发送失败', value: totals?.failures ?? 0, icon: CircleAlert, unit: '次', note: '与收稿人相关的发送错误' },
  ] as const
  const selectedMetric = cards.find((card) => card.key === metric)!
  const rangeLabel = !start && !end ? '全部时间' : `${start || '最早记录'} — ${end || '至今'}`

  return (
    <div className="stats-workspace" aria-busy={loading}>
      <div className="toolbar stats-toolbar">
        <div className="filters">
          <CalendarDays size={16} className="stats-filter-icon" aria-hidden="true" />
          <Select value={group} onChange={setGroup} ariaLabel="统计粒度" className="filter-select"
            options={[
              { value: 'day', label: '按日统计' },
              { value: 'week', label: '按周统计' },
              { value: 'month', label: '按月统计' },
            ]} />
          <label className="stats-date">
            <span>开始</span>
            <input type="date" aria-label="统计开始日期" value={start} onChange={(e) => { setStart(e.target.value); setPreset(null) }} />
          </label>
          <label className="stats-date">
            <span>结束</span>
            <input type="date" aria-label="统计结束日期" value={end} onChange={(e) => { setEnd(e.target.value); setPreset(null) }} />
          </label>
          <div className="stats-quick">
            <button type="button" aria-pressed={preset === '7'} onClick={() => quick(7)}>近 7 天</button>
            <button type="button" aria-pressed={preset === '30'} onClick={() => quick(30)}>近 30 天</button>
            <button type="button" aria-pressed={preset === 'month'} onClick={() => quickMonth()}>本月</button>
            <button type="button" aria-pressed={preset === 'all'} onClick={() => quick(null)}>全部</button>
          </div>
        </div>
        <div className="toolbar-actions">
          <IconButton title="刷新" onClick={() => void reload()} disabled={loading}>
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
          </IconButton>
        </div>
      </div>
      {notice && <div className="notice notice-error" role="alert">{notice}</div>}

      {loading ? <div className="panel stats-loading" role="status"><RefreshCw size={20} className="spin" />正在读取投稿统计…</div> : !report ? null : (
        <>
          <div className="stats-cards">
            {cards.map((c) => (
              <button type="button" key={c.key} className={`stats-card stats-tone-${c.key}`} aria-pressed={metric === c.key}
                aria-label={`${c.label} ${c.value} ${c.unit}，查看趋势`} onClick={() => setMetric(c.key)}>
                <span className="stats-card-top"><span className="stats-card-label">{c.label}</span><c.icon size={16} strokeWidth={1.7} /></span>
                <span className="stats-card-number"><span className="stats-card-value">{c.value.toLocaleString('zh-CN')}</span><small>{c.unit}</small></span>
                <span className="stats-card-note">{c.note}</span>
              </button>
            ))}
          </div>

          {!!report.groups.length && <StatsTrend rows={report.groups} metric={metric} label={selectedMetric.label} unit={selectedMetric.unit} formatPeriod={(period) => periodLabel(period, group)} />}

          <div className="panel stats-detail">
            <div className="stats-section-heading">
              <div><h2><List size={16} />统计明细</h2><span>{rangeLabel} · {group === 'day' ? '按日' : group === 'week' ? '按周' : '按月'}汇总</span></div>
              <span className="stats-period-count">共 {report.groups.length} 个周期</span>
            </div>
            {!report.groups.length ? (
              <EmptyState icon={BarChart3} title="该时间段内没有数据"
                desc="换个日期范围或统计粒度试试。" />
            ) : (
              <Table
                className="stats-table"
                minWidth={720}
                rowKey="period"
                dataSource={report.groups}
                resetKey={`${start}\0${end}\0${group}`}
                pagination={{ pageSize: 6, pageSizeOptions: [6, 10, 20, 50] }}
                columns={[
                  {
                    key: 'period',
                    title: '期间',
                    width: '20%',
                    className: 'mono',
                    render: (_value, g) => periodLabel(g.period, group),
                  },
                  {
                    key: 'deliveries',
                    title: '投递次数',
                    width: '14%',
                    align: 'right',
                    className: 'num',
                    render: (_value, g) => g.deliveries.toLocaleString('zh-CN'),
                  },
                  {
                    key: 'share',
                    title: '投递量对比',
                    width: '22%',
                    className: 'stats-bar-cell',
                    render: (_value, g) => (
                      <div className="stats-bar">
                        <i style={{ width: `${Math.round((g.deliveries / maxDeliveries) * 100)}%` }} />
                      </div>
                    ),
                  },
                  {
                    key: 'human',
                    title: '人工回复',
                    width: '16%',
                    align: 'right',
                    className: 'num',
                    render: (_value, g) => g.human_replies.toLocaleString('zh-CN'),
                  },
                  {
                    key: 'fail',
                    title: '失败',
                    width: '14%',
                    align: 'right',
                    className: 'num',
                    render: (_value, g) => g.failures.toLocaleString('zh-CN'),
                  },
                  {
                    key: 'accepted',
                    title: '过稿',
                    width: '14%',
                    align: 'right',
                    className: 'num',
                    render: (_value, g) => g.accepted.toLocaleString('zh-CN'),
                  },
                ]}
              />
            )}
          </div>
        </>
      )}
      {report && !loading && <p className="stats-footnote">投递按发送时间、回复按收信时间、失败按错误发生时间统计；过稿回复可能同时计入人工回复。</p>}
    </div>
  )
}
