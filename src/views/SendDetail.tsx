import { useEffect, useMemo, useState } from 'react'
import { Inbox, Plus, RotateCcw, Search, X } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { Table } from '../components/Table'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton } from '../components/ui'
import { formatTime, parseRecipient } from '../format'
import { useNav } from '../nav'
import type { Account, Delivery, Editor, Manuscript } from '../types'
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
  sent: boolean
  sentCount: number
  lastSentAt: string | null
}

export function SendDetailModal({ manuscript, deliveries, editors, enabledAccounts, locked, onClose, onChanged }: {
  manuscript: Manuscript
  deliveries: Delivery[]
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
  const [more, setMore] = useState<{ key: string; top: number; left: number; width: number; workTypes: string[] } | null>(null)

  // 只看这个计划自己的投递记录，按收件人邮箱归组。
  const sentByEmail = useMemo(() => {
    const map = new Map<string, Delivery[]>()
    for (const d of deliveries) {
      if (d.manuscript_id !== manuscript.id) continue
      const email = parseRecipient(d.recipient).email.toLowerCase()
      const list = map.get(email) ?? []
      list.push(d)
      map.set(email, list)
    }
    return map
  }, [deliveries, manuscript.id])

  // 按默认发送顺序（收件人保存顺序）排列，并补充编辑资料与发送状态。
  const rows = useMemo<DetailRow[]>(() => recipients.map((raw, i) => {
    const parsed = parseRecipient(raw)
    const email = parsed.email.toLowerCase()
    const editor = editors.find((e) => e.email.toLowerCase() === email)
    const profile = editor ? normalizeEditorTags(editor) : null
    const sent = sentByEmail.get(email) ?? []
    return {
      order: i + 1,
      raw,
      name: profile?.name.trim() || parsed.name || parsed.email,
      platform: profile?.platform.trim() || '—',
      email: parsed.email,
      notes: (profile?.notes ?? '').trim(),
      work_type: profile?.work_type ?? [],
      sent: sent.length > 0,
      sentCount: sent.length,
      lastSentAt: sent.length ? sent[sent.length - 1].sent_at : null,
    }
  }), [recipients, editors, sentByEmail])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = rows
    if (filter === 'sent') list = list.filter((r) => r.sent)
    else if (filter === 'unsent') list = list.filter((r) => !r.sent)
    if (!q) return list
    return list.filter((r) =>
      [r.name, r.platform, r.email, r.notes, r.raw, ...r.work_type].join(' ').toLowerCase().includes(q))
  }, [rows, query, filter])

  const sentCount = rows.filter((r) => r.sent).length

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
      return [next.name, next.platform, next.email, next.notes, ...(next.work_type ?? [])].join(' ').toLowerCase().includes(q)
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
      onChanged()
    } catch (e) { toast(String(e), 'error') }
  }

  const removeRecipient = (email: string) => {
    if (locked) { toast('计划正在发送，请先停止再修改收件人', 'warning'); return }
    void mutateRecipients(
      recipients.filter((r) => parseRecipient(r).email.toLowerCase() !== email.toLowerCase()),
      '已从计划中移除该编辑',
    )
  }

  const resend = async (row: DetailRow) => {
    const sent = sentByEmail.get(row.email.toLowerCase()) ?? []
    const latest = sent[sent.length - 1]
    if (!latest) { toast('没有找到可重发的投递记录', 'warning'); return }
    const ok = await confirm({
      title: '重新发送？',
      message: `将把「${row.name}」的稿件邮件重新发送一份到 ${row.email}，使用原发件账号。`,
      confirmLabel: '重新发送',
    })
    if (!ok) return
    setResending(row.email.toLowerCase())
    try {
      await api.resendDelivery(latest.id)
      toast('已重新发送', 'success')
      onChanged()
    } catch (e) { toast(String(e), 'error') }
    finally { setResending(null) }
  }

  const addEditor = (editor: Editor) => {
    if (locked) { toast('计划正在发送，请先停止再修改收件人', 'warning'); return }
    void mutateRecipients([...recipients, editorRecipient(editor)], '已加入计划，将按新顺序发送')
    setShowPicker(false)
    setPickQuery('')
  }

  const manualSend = async (row: DetailRow) => {
    if (locked) { toast('这个计划正在发送，请先停止', 'warning'); return }
    if (!enabledAccounts.length) { toast('没有可用的发件邮箱，请先启用', 'warning'); return }
    const ok = await confirm({
      title: '手动发送？',
      message: `将把「${row.name}」的稿件邮件手动发送到 ${row.email}，使用已启用的发件邮箱。`,
      confirmLabel: '手动发送',
    })
    if (!ok) return
    setResending(row.email.toLowerCase())
    try {
      await api.sendManualDelivery(manuscript.id, row.raw, enabledAccounts.map((a) => a.id))
      toast('已手动发送', 'success')
      onChanged()
    } catch (e) { toast(String(e), 'error') }
    finally { setResending(null) }
  }

  return (
    <Modal title="记录" width={1080} onClose={onClose}>
      <div className="send-detail-head">
        <div className="send-detail-title">
          <h3>{manuscript.title}</h3>
          <p>按默认发送顺序排列 · 共 {recipients.length} 位收件人 · 已发送 {sentCount} · 未发送 {recipients.length - sentCount}</p>
        </div>
        <div className="send-detail-actions">
          <label className="plan-search send-detail-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名、平台、邮箱或备注" />
          </label>
          <Button size="sm" disabled={locked} onClick={() => setShowPicker((v) => !v)}><Plus size={14} />添加编辑</Button>
        </div>
      </div>

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
                    open={more?.key === `pick-${e.id}`}
                    onToggle={(el, tags) => {
                      const next = moreRect(el)
                      setMore(more?.key === `pick-${e.id}` ? null : { key: `pick-${e.id}`, ...next, workTypes: tags })
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
              pagination={{ pageSize: 10, pageSizeOptions: [10, 20, 50] }}
              empty={filter === 'sent' ? '还没有发送成功的记录。' : filter === 'unsent' ? '没有未发送的收件人。' : '没有匹配的收件人'}
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
                      open={more?.key === `row-${r.email}`}
                      onToggle={(el, tags) => {
                        const next = moreRect(el)
                        setMore(more?.key === `row-${r.email}` ? null : { key: `row-${r.email}`, ...next, workTypes: tags })
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
                        <Button size="sm" disabled={locked || resending !== null} onClick={() => void manualSend(r)}>
                          {resending === r.email.toLowerCase() ? '发送中…' : '手动发送'}
                        </Button>
                      )}
                      {r.sent && (
                        <IconButton title={resending === r.email.toLowerCase() ? '发送中…' : '重新发送该编辑'}
                          disabled={resending !== null} onClick={() => void resend(r)}>
                          <RotateCcw size={14} />
                        </IconButton>
                      )}
                      <IconButton title={locked ? '计划正在发送，先停止再移除' : '移除该编辑'} className="danger"
                        disabled={locked} onClick={() => removeRecipient(r.email)}>
                        <X size={14} />
                      </IconButton>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}
      {more && (
        <EditorTagsPop
          top={more.top}
          left={more.left}
          width={more.width}
          workTypes={more.workTypes}
          skip={2}
          onClose={() => setMore(null)}
        />
      )}
    </Modal>
  )
}
