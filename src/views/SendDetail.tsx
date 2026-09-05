import { useEffect, useMemo, useState } from 'react'
import { Inbox, Plus, RotateCcw, Search, X } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { Table } from '../components/Table'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Pager } from '../components/ui'
import { formatTime, parseRecipient } from '../format'
import { useNav } from '../nav'
import type { Account, DeliverySummaryPage, PendingSend, Editor, Manuscript } from '../types'
import { EditorIdentity, EditorTagsPop, EditorTypeChips, moreRect } from './Editors'
import { editorRecipient, compareEditorsByFavorite, normalizeEditorTags, toInput } from './planShared'

interface DetailRow {
  order: number
  raw: string
  name: string
  platform: string
  email: string
  notes: string
  work_type: string[]
  rejected_types: string[]
  sent: boolean
  sentCount: number
  lastSentAt: string | null
  latestId: number | null
}

export function SendDetailModal({ manuscript, revision, editors, enabledAccounts, locked, onClose, onChanged }: {
  manuscript: Manuscript
  revision: number
  editors: Editor[]
  enabledAccounts: Account[]
  locked: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()
  // 收件人列表在弹窗内可改（移除 / 添加），改动后即时写库。
  const [recipients, setRecipients] = useState<string[]>(manuscript.recipients)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'sent' | 'unsent'>('all')
  const [showPicker, setShowPicker] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  const [resending, setResending] = useState<string | null>(null)
  const [more, setMore] = useState<{ key: string; top: number; left: number; width: number; workTypes: string[]; rejectedTypes: string[] } | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [result, setResult] = useState<DeliverySummaryPage | null>(null)
  const [pending, setPending] = useState<PendingSend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resolving, setResolving] = useState(false)
  const [refresh, setRefresh] = useState(0)

  const rows = useMemo<DetailRow[]>(() => {
    const byEmail = new Map(editors.map(e => [e.email.trim().toLowerCase(), normalizeEditorTags(e)]))
    return recipients.map((raw, i) => {
      const parsed = parseRecipient(raw)
      const profile = byEmail.get(parsed.email.trim().toLowerCase())
      return {
        order: i + 1, raw, name: profile?.name.trim() || parsed.name || parsed.email,
        platform: profile?.platform.trim() || '—', email: parsed.email,
        notes: (profile?.notes ?? '').trim(), work_type: profile?.work_type ?? [],
        rejected_types: profile?.rejected_types ?? [], sent: false, sentCount: 0, lastSentAt: null, latestId: null,
      }
    })
  }, [recipients, editors])
  const emails = useMemo(() => rows.map(r => r.email), [rows])
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.flatMap((r, i) => !q || [r.name, r.platform, r.email, r.notes, r.raw, ...r.work_type, ...r.rejected_types]
      .join(' ').toLowerCase().includes(q) ? [i] : [])
  }, [rows, query])

  useEffect(() => { setPage(1) }, [query, filter, pageSize, recipients])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    Promise.all([
      api.deliverySummaryPage(manuscript.id, emails, matching, filter, pageSize, (page - 1) * pageSize),
      api.listPendingSends(manuscript.id),
    ]).then(([next, pending]) => {
      if (cancelled) return
      setResult(next)
      setPending(pending)
      setPage(p => Math.min(p, Math.max(1, Math.ceil(next.total / pageSize))))
    }).catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [manuscript.id, emails, matching, filter, pageSize, page, revision, refresh, locked])

  const filtered = useMemo(() => (result?.items ?? []).flatMap(summary => {
    const row = rows[summary.row_index]
    return row ? [{ ...row, sent: summary.sent_count > 0, sentCount: summary.sent_count,
      latestId: summary.latest_id, lastSentAt: summary.last_sent_at }] : []
  }), [rows, result])
  const sentCount = result?.sent_total
  const busy = locked || resending !== null || loading || Boolean(error) || pending.length > 0 || resolving
  const changed = () => { setRefresh(v => v + 1); onChanged() }
  const resolvePending = async (attempt: PendingSend, sent: boolean) => {
    if (locked || resending !== null || resolving || loading) return
    const ok = await confirm({
      title: sent ? '确认邮件已发出？' : '确认邮件未发出？',
      message: sent
        ? `请核对邮箱服务端或收件人反馈。确认后将补记 ${attempt.recipient} 的投递记录，不再发送邮件。`
        : `只有确认 ${attempt.recipient} 未收到这次投递时才继续。仅凭发件箱没有记录不足以确认；解除待确认状态后，后续发送可能产生重复邮件。`,
      confirmLabel: sent ? '已核对，补记成功' : '已核对，解除待确认',
    })
    if (!ok) return
    setResolving(true)
    try { await api.resolvePendingSend(attempt.id, sent); toast('发送结果已确认', 'success'); changed() }
    catch (e) { toast(String(e), 'error') }
    finally { setResolving(false) }
  }

  const manualAccounts = useMemo(() => {
    if (!manuscript.account_ids.length) return enabledAccounts
    return enabledAccounts.filter((account) => manuscript.account_ids.includes(account.id))
  }, [enabledAccounts, manuscript.account_ids])

  // 添加编辑：编辑库中还没进这个计划的编辑。
  const existingEmails = useMemo(
    () => new Set(recipients.map((r) => parseRecipient(r).email.toLowerCase())),
    [recipients],
  )
  const candidates = useMemo(
    () => editors.filter((e) => !existingEmails.has(e.email.toLowerCase())),
    [editors, existingEmails],
  )
  const filteredCandidates = useMemo(() => {
    const q = pickQuery.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((e) => {
      const next = normalizeEditorTags(e)
      return [next.name, next.platform, next.email, next.notes, ...(next.work_type ?? []), ...(next.rejected_types ?? [])].join(' ').toLowerCase().includes(q)
    })
  }, [candidates, pickQuery])

  const pickerRows = useMemo(
    () => filteredCandidates.map(normalizeEditorTags).sort(compareEditorsByFavorite),
    [filteredCandidates],
  )

  useEffect(() => { setMore(null) }, [query, filter, pickQuery])

  const mutateRecipients = async (next: string[], okMsg: string) => {
    if (next.length === recipients.length) return
    try {
      await api.updateManuscript(manuscript.id, { ...toInput(manuscript), recipients: next })
      setRecipients(next)
      toast(okMsg, 'success')
      changed()
    } catch (e) { toast(String(e), 'error') }
  }

  const removeRecipient = (email: string) => {
    if (busy) { toast('请等待当前发送结束后再修改收件人', 'warning'); return }
    void mutateRecipients(
      recipients.filter((r) => parseRecipient(r).email.toLowerCase() !== email.toLowerCase()),
      '已从计划中移除该编辑',
    )
  }

  const resend = async (row: DetailRow) => {
    if (busy) { toast('请等待当前发送结束后再重发', 'warning'); return }
    if (row.latestId === null) { toast('没有找到可重发的投递记录', 'warning'); return }
    const ok = await confirm({
      title: '重新发送？',
      message: `将把「${row.name}」的稿件邮件重新发送一份到 ${row.email}，使用原发件账号。`,
      confirmLabel: '重新发送',
    })
    if (!ok) return
    setResending(row.email.toLowerCase())
    try {
      await api.resendDelivery(row.latestId)
      toast('已重新发送', 'success')
      changed()
    } catch (e) { toast(String(e), 'error') }
    finally { setResending(null); setRefresh(v => v + 1) }
  }

  const addEditor = (editor: Editor) => {
    if (busy) { toast('请等待当前发送结束后再修改收件人', 'warning'); return }
    void mutateRecipients([...recipients, editorRecipient(editor)], '已加入计划，将按新顺序发送')
    setShowPicker(false)
    setPickQuery('')
  }

  const manualSend = async (row: DetailRow) => {
    if (busy) { toast('这个计划正在发送，请先停止', 'warning'); return }
    if (!manualAccounts.length) { toast('计划配置的发件邮箱不可用，请先检查邮箱设置', 'warning'); return }
    const accountLabel = manualAccounts.length === 1
      ? manualAccounts[0].email
      : `计划配置的 ${manualAccounts.length} 个发件邮箱中的可用邮箱`
    const ok = await confirm({
      title: '手动发送？',
      message: `将把「${row.name}」的稿件邮件手动发送到 ${row.email}，使用 ${accountLabel}。`,
      confirmLabel: '手动发送',
    })
    if (!ok) return
    setResending(row.email.toLowerCase())
    try {
      await api.sendManualDelivery(manuscript.id, row.raw, manualAccounts.map((a) => a.id))
      toast('已手动发送', 'success')
      changed()
    } catch (e) { toast(String(e), 'error') }
    finally { setResending(null); setRefresh(v => v + 1) }
  }

  return (
    <Modal title="记录" width={1080} onClose={onClose}>
      <div className="send-detail-head">
        <div className="send-detail-title">
          <h3>{manuscript.title}</h3>
          <p>按默认发送顺序排列 · 共 {recipients.length} 位收件人 · 已发送 {sentCount ?? '…'} · 未发送 {sentCount === undefined ? '…' : recipients.length - sentCount}</p>
        </div>
        <div className="send-detail-actions">
          <label className="plan-search send-detail-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名、平台、邮箱或备注" />
          </label>
          <Button size="sm" disabled={busy} onClick={() => setShowPicker((v) => !v)}><Plus size={14} />添加编辑</Button>
        </div>
      </div>

      {pending.map(attempt => (
        <div key={attempt.id} className="send-detail-pending" role="status">
          <strong>发送结果待确认</strong>
          <p>{attempt.recipient} · {attempt.subject} · {formatTime(attempt.created_at)}</p>
          <p>发件邮箱：{attempt.account_email || `账号 #${attempt.account_id}`}</p>
          <p>Message-ID：{attempt.message_id}。请先核对邮箱服务端或收件人反馈，暂缓重发。</p>
          <div className="send-detail-pending-actions">
          <Button size="sm" disabled={locked || resolving || resending !== null || loading} onClick={() => void resolvePending(attempt, true)}>已发出，补记成功</Button>
          <Button size="sm" disabled={locked || resolving || resending !== null || loading} onClick={() => void resolvePending(attempt, false)}>未发出，解除待确认</Button>
          </div>
        </div>
      ))}
      {error && <p className="warn-text" role="alert">{error} <Button size="sm" onClick={() => setRefresh(v => v + 1)}>重试加载</Button></p>}

      {locked && (
        <p className="warn-text send-detail-locked">这个计划正在发送，收件人修改和手动发送已暂停，停止后才能操作。</p>
      )}

      {showPicker && (
        <div className="send-detail-picker">
          <div className="send-detail-picker-head">
            <label className="plan-search">
              <Search size={14} />
              <input value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} placeholder="搜索姓名、平台、邮箱或备注" />
            </label>
            <span className="hint">{pickerRows.length} 位可选</span>
          </div>
          <Table
            rowKey="id"
            dataSource={pickerRows}
            resetKey={pickQuery}
            pagination={{ pageSize: 6, pageSizeOptions: [6, 10, 20], hideOnSinglePage: true }}
            empty={editors.length
              ? '编辑库中没有可添加的编辑（或都已在这个计划里）。'
              : <>编辑库还是空的，去 <button type="button" className="text-link" onClick={() => go('editors')}>编辑</button> 页添加吧。</>}
            columns={[
              {
                key: 'editor',
                title: '编辑',
                width: 220,
                render: (_value, e) => (
                  <div className="editor-row-main">
                    <EditorIdentity name={e.name} platform={e.platform} email={e.email} />
                  </div>
                ),
              },
              {
                key: 'notes',
                title: '备注',
                ellipsis: { rows: 2 },
                render: (_value, e) => {
                  const note = (e.notes ?? '').trim()
                  return note || <span className="hint">无备注</span>
                },
              },
              {
                key: 'work_type',
                title: '作品类型',
                width: 160,
                render: (_value, e) => (
                  <EditorTypeChips
                    workTypes={e.work_type}
                    rejectedTypes={e.rejected_types}
                    open={more?.key === `pick-${e.id}`}
                    onToggle={(el, tags, rejected) => {
                      const next = moreRect(el)
                      setMore(more?.key === `pick-${e.id}` ? null : { key: `pick-${e.id}`, ...next, workTypes: tags, rejectedTypes: rejected })
                    }}
                  />
                ),
              },
              {
                key: 'actions',
                title: '',
                width: 72,
                render: (_value, e) => (
                  <div className="row-actions">
                    <Button size="sm" onClick={() => addEditor(e)}>添加</Button>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      {!rows.length ? (
        <EmptyState icon={Inbox} title="这个计划还没有收件人"
          desc="点击右上角「添加编辑」从编辑库选人，这里会按发送顺序列出每一位。" />
      ) : (
        <>
          <div className="send-detail-filter" role="group" aria-label="发送状态筛选">
            {([['all', '全部'], ['sent', '已发送'], ['unsent', '未发送']] as const).map(([value, label]) => (
              <button key={value} type="button" className={`seg-btn ${filter === value ? 'is-active' : ''}`}
                onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <div className="panel send-detail-list">
            <Table
              rowKey={(r) => `${r.order}-${r.email}`}
              dataSource={filtered}
              resetKey={`${query}\0${filter}`}
              pagination={false}
              empty={loading ? '正在加载记录…' : error ? '记录加载失败，请重试' : filter === 'sent' ? '还没有发送成功的记录。' : filter === 'unsent' ? '没有未发送的收件人。' : '没有匹配的收件人'}
              columns={[
                {
                  key: 'editor',
                  title: '编辑',
                  width: 220,
                  render: (_value, r) => (
                    <div className="editor-row-main">
                      <EditorIdentity name={r.name} platform={r.platform} email={r.email} />
                    </div>
                  ),
                },
                {
                  key: 'notes',
                  title: '备注',
                  ellipsis: { rows: 2 },
                  render: (_value, r) => r.notes.trim() || <span className="hint">无备注</span>,
                },
                {
                  key: 'work_type',
                  title: '作品类型',
                  width: 160,
                  render: (_value, r) => (
                    <EditorTypeChips
                      workTypes={r.work_type}
                      rejectedTypes={r.rejected_types}
                      open={more?.key === `row-${r.email}`}
                      onToggle={(el, tags, rejected) => {
                        const next = moreRect(el)
                        setMore(more?.key === `row-${r.email}` ? null : { key: `row-${r.email}`, ...next, workTypes: tags, rejectedTypes: rejected })
                      }}
                    />
                  ),
                },
                {
                  key: 'status',
                  title: '状态',
                  width: 92,
                  render: (_value, r) => (
                    <div className="editor-row-status">
                      {r.sent
                        ? <Badge tone="success" dot>已发送{r.sentCount > 1 ? ` ×${r.sentCount}` : ''}</Badge>
                        : <Badge tone="neutral">未发送</Badge>}
                      <small>{r.lastSentAt ? formatTime(r.lastSentAt) : '—'}</small>
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  title: '',
                  width: 140,
                  render: (_value, r) => (
                    <div className="row-actions">
                      {!r.sent && (
                        <Button size="sm" disabled={busy} onClick={() => void manualSend(r)}>
                          {resending === r.email.toLowerCase() ? '发送中…' : '手动发送'}
                        </Button>
                      )}
                      {r.sent && (
                        <IconButton title={resending === r.email.toLowerCase() ? '发送中…' : '重新发送该编辑'}
                          disabled={busy} onClick={() => void resend(r)}>
                          <RotateCcw size={14} />
                        </IconButton>
                      )}
                      <IconButton title={locked ? '计划正在发送，先停止再移除' : '移除该编辑'} className="danger"
                        disabled={busy} onClick={() => removeRecipient(r.email)}>
                        <X size={14} />
                      </IconButton>
                    </div>
                  ),
                },
              ]}
            />
            {result && !loading && !error && <Pager page={page} pageCount={Math.max(1, Math.ceil(result.total / pageSize))}
              pageSize={pageSize} total={result.total} onPage={setPage} onPageSize={setPageSize} />}
          </div>
        </>
      )}
      {more && (
        <EditorTagsPop
          top={more.top}
          left={more.left}
          width={more.width}
          workTypes={more.workTypes}
          rejectedTypes={more.rejectedTypes}
          skip={more.workTypes.length && more.rejectedTypes.length ? 1 : 2}
          onClose={() => setMore(null)}
        />
      )}
    </Modal>
  )
}
