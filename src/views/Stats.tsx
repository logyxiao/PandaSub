import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, RefreshCw } from 'lucide-react'
import { api } from '../api'
import { EmptyState, IconButton, Select } from '../components/ui'
import { Table } from '../components/Table'
import type { StatsReport } from '../types'

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
  const [report, setReport] = useState<StatsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const requestSeq = useRef(0)

  const load = useCallback(async (s: string, e: string, g: GroupMode) => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const next = await api.getStats(s || undefined, e || undefined, g)
      if (seq !== requestSeq.current) return
      setReport(next); setNotice('')
    } catch (err) { if (seq === requestSeq.current) { setNotice(String(err)); setReport(null) } }
    finally { if (seq === requestSeq.current) setLoading(false) }
  }, [])

  useEffect(() => {
    void load(start, end, group)
    const sequence = requestSeq
    return () => { sequence.current++ }
  }, [load, start, end, group])

  const quick = (days: number | null) => {
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
    { key: 'deliveries', label: '投递次数', value: totals?.deliveries ?? 0, cls: '' },
    { key: 'human_replies', label: '人工回复', value: totals?.human_replies ?? 0, cls: 'is-brand' },
    { key: 'failures', label: '失败', value: totals?.failures ?? 0, cls: 'is-danger' },
    { key: 'accepted', label: '过稿', value: totals?.accepted ?? 0, cls: 'is-success' },
  ]

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <Select value={group} onChange={setGroup} ariaLabel="统计粒度" className="filter-select"
            options={[
              { value: 'day', label: '按日统计' },
              { value: 'week', label: '按周统计' },
              { value: 'month', label: '按月统计' },
            ]} />
          <label className="stats-date">
            <span>从</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="stats-date">
            <span>到</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="stats-quick">
            <button type="button" onClick={() => quick(7)}>近 7 天</button>
            <button type="button" onClick={() => quick(30)}>近 30 天</button>
            <button type="button" onClick={() => quickMonth()}>本月</button>
            <button type="button" onClick={() => quick(null)}>全部</button>
          </div>
        </div>
        <div className="toolbar-actions">
          <IconButton title="刷新" onClick={() => void load(start, end, group)} disabled={loading}>
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
          </IconButton>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!report ? null : (
        <>
          <div className="stats-cards">
            {cards.map((c) => (
              <div key={c.key} className={`stats-card ${c.cls}`}>
                <div className="stats-card-label">{c.label}</div>
                <div className="stats-card-value">{c.value}</div>
              </div>
            ))}
          </div>

          <div className="panel">
            {!report.groups.length ? (
              <EmptyState icon={BarChart3} title="该时间段内没有数据"
                desc="换个日期范围或统计粒度试试。" />
            ) : (
              <Table
                rowKey="period"
                dataSource={report.groups}
                resetKey={`${start}\0${end}\0${group}`}
                pagination={{ pageSize: 50 }}
                columns={[
                  {
                    key: 'period',
                    title: '期间',
                    className: 'mono',
                    render: (_value, g) => periodLabel(g.period, group),
                  },
                  {
                    key: 'deliveries',
                    title: '投递次数',
                    width: 100,
                    align: 'right',
                    className: 'num',
                    dataIndex: 'deliveries',
                  },
                  {
                    key: 'share',
                    title: '占比',
                    width: 140,
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
                    width: 88,
                    align: 'right',
                    className: 'num',
                    render: (_value, g) => g.human_replies || '—',
                  },
                  {
                    key: 'fail',
                    title: '失败',
                    width: 72,
                    align: 'right',
                    className: 'num',
                    render: (_value, g) => g.failures || '—',
                  },
                  {
                    key: 'accepted',
                    title: '过稿',
                    width: 72,
                    align: 'right',
                    className: 'num',
                    render: (_value, g) => g.accepted || '—',
                  },
                ]}
              />
            )}
          </div>
        </>
      )}
    </>
  )
}
