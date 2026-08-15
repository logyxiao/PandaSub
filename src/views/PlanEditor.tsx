import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, Check, Clock3, FileText, FileUp, Mail, Search, Send, Trash2, Users } from 'lucide-react'
import { useToast } from '../components/feedback'
import { Badge, Button, IconButton, Select } from '../components/ui'
import { formatDurationRange, isValidEmail, parseRecipient } from '../format'
import { useNav } from '../nav'
import type { Account, Delivery, Editor, Manuscript, ManuscriptInput, Settings, TaskInput } from '../types'
import {
  CATEGORIES, EMOTIONS, GENRES, READERS, STYLES, TEMPLATES,
  countChars, editorMatchesGenres, editorRecipient, estimateMinutes, fillPlaceholders, sentCountByEmail,
} from './planShared'

type Pace = 'steady' | 'balanced' | 'fast'
type RecipientFilter = 'all' | 'pending' | 'sent' | 'invalid'

export function PlanEditor({
  editing, manuscripts, editors, deliveries, enabledAccounts, settings,
  form, setForm, taskForm, setTaskForm, scheduledInput, setScheduledInput,
  pace, applyPace, saving, onClose, onSaveDraft, onSaveAndSend, onImportFile,
}: {
  editing: Manuscript | null
  manuscripts: Manuscript[]
  editors: Editor[]
  deliveries: Delivery[]
  enabledAccounts: Account[]
  settings: Settings | null
  form: ManuscriptInput
  setForm: (next: ManuscriptInput | ((f: ManuscriptInput) => ManuscriptInput)) => void
  taskForm: TaskInput
  setTaskForm: (next: TaskInput | ((f: TaskInput) => TaskInput)) => void
  scheduledInput: string
  setScheduledInput: (v: string) => void
  pace: Pace
  applyPace: (pace: Pace, base: Settings) => void
  saving: boolean
  onClose: () => void
  onSaveDraft: () => void
  onSaveAndSend: (skipSent: boolean) => void
  onImportFile: (file: File | null) => void
}) {
  const toast = useToast()
  const { go } = useNav()
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RecipientFilter>('all')
  const [skipSent, setSkipSent] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [previewOn, setPreviewOn] = useState(true)
  const [poolMode, setPoolMode] = useState<'match' | 'all'>('match')
  const [poolQuery, setPoolQuery] = useState('')
  const [poolPlatform, setPoolPlatform] = useState('')

  const sentMap = useMemo(() => sentCountByEmail(deliveries), [deliveries])
  const liveCount = form.word_count || countChars(form.body)
  const firstRecipient = form.recipients.find((r) => isValidEmail(r)) ?? ''
  const previewSubject = fillPlaceholders(form.subject.trim() || form.title || '（未写主题）', firstRecipient, form.title)
  const previewBody = fillPlaceholders(form.body || '还没有正文。', firstRecipient, form.title)

  const rows = useMemo(() => {
    return form.recipients.map((raw, index) => {
      const parsed = parseRecipient(raw)
      const valid = isValidEmail(raw)
      const sent = sentMap.get(parsed.email.toLowerCase()) ?? 0
      return { raw, index, ...parsed, valid, sent }
    })
  }, [form.recipients, sentMap])

  const pending = rows.filter((r) => r.valid && r.sent === 0).length
  const sent = rows.filter((r) => r.sent > 0).length
  const invalid = rows.filter((r) => !r.valid).length
  const sendCount = skipSent ? pending : rows.filter((r) => r.valid).length
  const minutes = estimateMinutes(sendCount, taskForm.interval_min, taskForm.interval_max, taskForm.batch_size_min, taskForm.batch_size_max, taskForm.batch_pause_min, taskForm.batch_pause_max)

  const visible = rows.filter((r) => {
    if (filter === 'pending' && !(r.valid && r.sent === 0)) return false
    if (filter === 'sent' && r.sent === 0) return false
    if (filter === 'invalid' && r.valid) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return r.raw.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)
  })

  const ready = Boolean(form.title.trim() && form.body.trim() && sendCount > 0 && enabledAccounts.length)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        onSaveDraft()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSaveDraft])

  const addRecipients = (text: string) => {
    const next = text.split(/[\n,;，；\t]/).map((s) => s.trim()).filter(Boolean)
    if (!next.length) return
    const bad = next.filter((r) => !isValidEmail(r))
    const seen = new Set(form.recipients.map((r) => parseRecipient(r).email.toLowerCase()))
    const unique = next.filter((r) => {
      if (!isValidEmail(r)) return false
      const email = parseRecipient(r).email.toLowerCase()
      if (seen.has(email)) return false
      seen.add(email)
      return true
    })
    if (bad.length && !unique.length) { toast(`这些格式不对：${bad.slice(0, 3).join('、')}`, 'warning'); return }
    if (!unique.length) { toast('没有新的收件人', 'info'); return }
    setForm((f) => ({ ...f, recipients: [...f.recipients, ...unique] }))
    setDraft('')
    if (bad.length) toast(`已加入 ${unique.length} 家，跳过 ${bad.length} 个格式不对的`, 'warning')
  }

  const importListFile = async (file: File | null) => {
    if (!file) return
    addRecipients(await file.text())
  }

  const importFromPlan = (id: number) => {
    const source = manuscripts.find((m) => m.id === id)
    if (!source) return
    addRecipients(source.recipients.join('\n'))
  }

  const poolPlatforms = useMemo(
    () => [...new Set(editors.map((e) => e.platform.trim()).filter(Boolean))].sort(),
    [editors],
  )

  const pool = useMemo(() => {
    const q = poolQuery.trim().toLowerCase()
    return editors.filter((e) => {
      if (poolMode === 'match' && !editorMatchesGenres(e, form.genres)) return false
      if (poolPlatform && e.platform !== poolPlatform) return false
      if (!q) return true
      return [e.name, e.email, e.platform, ...(e.directions ?? [])].join(' ').toLowerCase().includes(q)
    })
  }, [editors, form.genres, poolMode, poolPlatform, poolQuery])

  const addFromPool = (list: Editor[]) => {
    if (poolMode === 'match' && !form.genres.length) {
      toast('先在左侧勾选作品类型，再按收稿方向加入编辑', 'warning')
      return
    }
    addRecipients(list.map(editorRecipient).join('\n'))
  }

  const moveRow = (email: string, dir: -1 | 1) => {
    setForm((f) => {
      const i = f.recipients.findIndex((r) => parseRecipient(r).email === email)
      const j = i + dir
      if (i < 0 || j < 0 || j >= f.recipients.length) return f
      const copy = [...f.recipients]
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return { ...f, recipients: copy }
    })
  }

  const insertToken = (token: string) => {
    const el = bodyRef.current
    if (!el) {
      setForm((f) => ({ ...f, body: f.body + token }))
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = form.body.slice(0, start) + token + form.body.slice(end)
    setForm((f) => ({ ...f, body: next }))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)
    if (!t) return
    setForm((f) => ({
      ...f,
      subject: f.subject.trim() ? f.subject : t.subject,
      body: f.body.trim() ? f.body : t.body,
    }))
    toast(form.body.trim() ? '主题已按模板补上（正文有内容，未覆盖）' : `已套用「${t.name}」`, 'success')
  }

  return (
    <div className="plan-desk">
      <header className="plan-bar">
        <button className="plan-back" onClick={onClose}><ArrowLeft size={16} />返回计划</button>
        <div className="plan-bar-title">
          <span>{editing ? '编辑投稿计划' : '新建投稿计划'}</span>
          <strong>{form.title.trim() || '未命名作品'}</strong>
        </div>
        <div className="plan-checks" aria-label="计划完成度">
          {([
            ['作品资料', Boolean(form.title.trim()), FileText],
            ['投稿邮件', Boolean(form.body.trim()), Mail],
            ['收件名单', sendCount > 0, Users],
            ['发件邮箱', enabledAccounts.length > 0, Send],
          ] as const).map(([label, done, Icon]) => (
            <div className={done ? 'on' : ''} key={label}><span>{done ? <Check size={11} /> : <Icon size={12} />}</span>{label}</div>
          ))}
        </div>
        <div className="plan-bar-actions">
          <Button variant="ghost" disabled={saving} onClick={onSaveDraft}>保存草稿</Button>
          <Button variant="primary" disabled={saving || !ready} onClick={() => onSaveAndSend(skipSent)}>
            <Send size={15} />{taskForm.schedule_type === 'scheduled' ? '预约发送' : '开始发送'}
          </Button>
        </div>
      </header>

      <div className="plan-split">
        <section className="plan-sheet">
          <div className="plan-section-heading">
            <span className="plan-section-icon"><FileText size={17} /></span>
            <div><span>01 · 稿件资料</span><h2>先确认要投递的作品</h2><p>导入作品文件，补充名称和分类，便于后续查找与复用。</p></div>
          </div>
          <div className="plan-work-card plan-manuscript-card">
          <div
            className={`plan-drop ${dragging ? 'is-over' : ''} ${form.file_name ? 'has-file' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); void onImportFile(e.dataTransfer.files[0] ?? null) }}
          >
            <input ref={fileRef} type="file" accept=".docx,.txt,.md,.html,.htm" hidden
              onChange={(e) => { void onImportFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
            <div>
              <b>{form.file_name || '把作品文件拖到这里'}</b>
              <p>Word / TXT / Markdown / HTML。读入后仍可改邮件正文。</p>
            </div>
            <Button variant="ghost" onClick={() => fileRef.current?.click()}><FileUp size={16} />选择文件</Button>
          </div>

          <label className="plan-title-field">
            <span>作品名称</span>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="写下要投的那篇" />
          </label>

          <div className="plan-meta">
            <label>字数
              <input type="number" min={0} value={form.word_count || ''}
                onChange={(e) => setForm({ ...form, word_count: Number(e.target.value) || 0 })}
                placeholder={String(liveCount || '')} />
            </label>
            <label>篇幅
              <Select value={form.category} onChange={(value) => setForm({ ...form, category: value })} ariaLabel="选择作品篇幅"
                options={[{ value: '', label: '未选择' }, ...CATEGORIES.map((x) => ({ value: x, label: x }))]} />
            </label>
            <label>读者
              <Select value={form.reader_category} onChange={(value) => setForm({ ...form, reader_category: value })} ariaLabel="选择读者类型"
                options={[{ value: '', label: '未选择' }, ...READERS.map((x) => ({ value: x, label: x }))]} />
            </label>
            <label>情绪
              <Select value={form.reader_emotion} onChange={(value) => setForm({ ...form, reader_emotion: value })} ariaLabel="选择作品情绪"
                options={[{ value: '', label: '未选择' }, ...EMOTIONS.map((x) => ({ value: x, label: x }))]} />
            </label>
            <label>风格
              <Select value={form.style} onChange={(value) => setForm({ ...form, style: value })} ariaLabel="选择作品风格"
                options={[{ value: '', label: '未选择' }, ...STYLES.map((x) => ({ value: x, label: x }))]} />
            </label>
          </div>

          <div className="plan-genre-row">
            <span>题材标签</span>
            <div className="chip-picks">
              {GENRES.map((g) => (
                <button type="button" key={g} className={`chip ${form.genres.includes(g) ? 'on' : ''}`}
                  onClick={() => setForm((f) => ({
                    ...f,
                    genres: f.genres.includes(g) ? f.genres.filter((x) => x !== g) : [...f.genres, g],
                  }))}>{g}</button>
              ))}
            </div>
          </div>
          </div>

          <div className="plan-section-heading plan-mail-heading">
            <span className="plan-section-icon"><Mail size={17} /></span>
            <div><span>02 · 投稿邮件</span><h2>写给编辑的正文</h2><p>主题保持明确，正文简洁说明作品和投稿目的。</p></div>
          </div>
          <div className="plan-work-card plan-mail">
            <div className="plan-mail-row">
              <label className="field grow">邮件主题
                <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="留空则用作品名称，可用 {{作品名}}" />
              </label>
              <label className="field">发件昵称
                <input value={form.sender_name} onChange={(e) => setForm({ ...form, sender_name: e.target.value })} placeholder="可留空" />
              </label>
            </div>
            <div className="plan-mail-tools">
              <div className="plan-tool-group"><span>插入变量</span>
                {['{{编辑昵称}}', '{{作品名}}', '{{邮箱}}'].map((t) => (
                  <button type="button" key={t} className="chip" onClick={() => insertToken(t)}>{t}</button>
                ))}
              </div>
              <div className="plan-tool-group"><span>快速模板</span>
                {TEMPLATES.map((t) => (
                  <button type="button" key={t.id} className="chip" onClick={() => applyTemplate(t.id)}>{t.name}</button>
                ))}
              </div>
              <label className="plan-inline">
                <input type="checkbox" checked={form.content_type === 'text/html'}
                  onChange={(e) => setForm({ ...form, content_type: e.target.checked ? 'text/html' : 'text/plain' })} />
                HTML 邮件
              </label>
            </div>
            <textarea ref={bodyRef} className="plan-body" rows={12} value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value, word_count: form.word_count || countChars(e.target.value) })}
              placeholder="尊敬的{{编辑昵称}}，您好……" />
            <div className="plan-body-meta">{liveCount} 字 · 正文会按每个收件人替换变量</div>
          </div>

          {previewOn && (
            <article className="plan-envelope" aria-label="发给编辑时的样子">
              <header>
                <Mail size={16} />
                <span>发给 {firstRecipient ? parseRecipient(firstRecipient).name : '第一位编辑'} 时</span>
                <button type="button" className="text-link" onClick={() => setPreviewOn(false)}>收起</button>
              </header>
              <h4>{previewSubject}</h4>
              <pre>{previewBody}</pre>
            </article>
          )}
          {!previewOn && <button type="button" className="text-link" onClick={() => setPreviewOn(true)}>看发给编辑时的样子</button>}
        </section>

        <aside className="plan-board">
          <div className="plan-board-head">
            <span className="plan-section-icon"><Users size={17} /></span>
            <div>
              <span>03 · 收件名单</span>
              <h3>选择要投稿的编辑部</h3>
              <p>共 {rows.length} 家 · 本次发送 {sendCount} 家</p>
            </div>
            <div className="plan-recipient-stats">
              <b>{pending}<small>未投</small></b>
              <b>{sent}<small>已投</small></b>
              {invalid > 0 && <b className="bad">{invalid}<small>无效</small></b>}
            </div>
          </div>

          <div className="plan-tabs">
            {([
              ['all', `全部 ${rows.length}`],
              ['pending', `未投 ${pending}`],
              ['sent', `已投 ${sent}`],
              ['invalid', `无效 ${invalid}`],
            ] as const).map(([id, label]) => (
              <button type="button" key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>

          <div className="plan-board-tools">
            <label className="plan-search">
              <Search size={14} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选姓名或邮箱" />
            </label>
            <input ref={listRef} type="file" accept=".txt,.csv,.md" hidden
              onChange={(e) => { void importListFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
            <Button size="sm" onClick={() => listRef.current?.click()}>导入名单</Button>
            {manuscripts.filter((m) => m.id !== editing?.id && m.recipients.length).length > 0 && (
              <Select value={''} onChange={(id) => { if (id) importFromPlan(Number(id)) }} ariaLabel="从其他计划导入收件人"
                className="plan-import-select" placeholder="从其他计划导入"
                options={[
                  { value: '', label: '从其他计划导入' },
                  ...manuscripts.filter((m) => m.id !== editing?.id && m.recipients.length).map((m) => ({
                    value: String(m.id), label: m.title, description: `${m.recipients.length} 位收件人`,
                  })),
                ]} />
            )}
          </div>

          <div className="plan-pool">
            <div className="plan-pool-head">
              <span>从编辑库加入</span>
              <div className="plan-pool-modes">
                <button type="button" className={poolMode === 'match' ? 'on' : ''} onClick={() => setPoolMode('match')}>
                  对上作品类型
                </button>
                <button type="button" className={poolMode === 'all' ? 'on' : ''} onClick={() => setPoolMode('all')}>
                  全部编辑
                </button>
              </div>
            </div>
            {!editors.length ? (
              <p className="plan-empty">
                还没有编辑。去
                <button type="button" className="text-link" onClick={() => go('editors')}>编辑</button>
                里先存邮箱和收稿方向。
              </p>
            ) : poolMode === 'match' && !form.genres.length ? (
              <p className="plan-empty">先在左侧勾选作品类型，再按收稿方向筛要投的人。也可以先看全部编辑。</p>
            ) : (
              <>
                <div className="plan-pool-tools">
                  <label className="plan-search">
                    <Search size={14} />
                    <input value={poolQuery} onChange={(e) => setPoolQuery(e.target.value)} placeholder="搜编辑库" />
                  </label>
                  {poolPlatforms.length > 0 && (
                    <select value={poolPlatform} onChange={(e) => setPoolPlatform(e.target.value)} aria-label="按平台筛选编辑">
                      <option value="">全部平台</option>
                      {poolPlatforms.map((p) => <option key={p}>{p}</option>)}
                    </select>
                  )}
                  <Button size="sm" variant="primary" onClick={() => addFromPool(pool)} disabled={!pool.length}>
                    加入筛选的 {pool.length} 人
                  </Button>
                </div>
                <div className="plan-pool-list">
                  {pool.map((e) => {
                    const added = form.recipients.some((r) => parseRecipient(r).email.toLowerCase() === e.email.toLowerCase())
                    return (
                      <div className={`plan-pool-item ${added ? 'is-added' : ''}`} key={e.id}>
                        <div>
                          <b>{e.name.trim() || e.email}</b>
                          <small>{[e.platform.trim(), e.name.trim() ? e.email : ''].filter(Boolean).join(' · ')}</small>
                        </div>
                        {(e.directions ?? []).length > 0 && (
                          <div className="chip-picks compact">
                            {e.directions.slice(0, 3).map((d) => (
                              <span className={`chip ${form.genres.includes(d) ? 'on' : ''}`} key={d}>{d}</span>
                            ))}
                          </div>
                        )}
                        {added
                          ? <Badge tone="neutral">已在名单</Badge>
                          : <Button size="sm" onClick={() => addFromPool([e])}>加入</Button>}
                      </div>
                    )
                  })}
                  {!pool.length && (
                    <p className="plan-empty">
                      {poolMode === 'match'
                        ? '没有对上当前作品类型的编辑。可改作品类型，或切到全部编辑。'
                        : '没有符合筛选的编辑。'}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="plan-add">
            <input value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipients(draft) } }}
              placeholder="编辑名 <email@qq.com>，或只写邮箱，回车添加" />
            <Button size="sm" variant="primary" onClick={() => addRecipients(draft)}>添加</Button>
          </div>

          <div className="plan-bulk">
            <button type="button" onClick={() => setForm((f) => ({ ...f, recipients: f.recipients.filter((r) => (sentMap.get(parseRecipient(r).email.toLowerCase()) ?? 0) === 0) }))}>去掉已投</button>
            <button type="button" onClick={() => setForm((f) => ({ ...f, recipients: f.recipients.filter((r) => isValidEmail(r)) }))}>去掉无效</button>
            <button type="button" onClick={() => setForm((f) => ({ ...f, recipients: [] }))}>清空</button>
          </div>

          <div className="plan-people">
            {visible.map((r) => (
              <div className={`plan-person ${!r.valid ? 'is-bad' : r.sent ? 'is-sent' : ''}`} key={`${r.email}-${r.index}`}>
                <em>{r.index + 1}</em>
                <div>
                  <b>{r.name}</b>
                  <small>{r.email}</small>
                </div>
                {r.sent > 0 && <Badge tone="neutral">已投 {r.sent}</Badge>}
                {!r.valid && <Badge tone="danger">无效</Badge>}
                <div className="row-actions">
                  <IconButton title="上移" onClick={() => moveRow(r.email, -1)}><ArrowUp size={14} /></IconButton>
                  <IconButton title="下移" onClick={() => moveRow(r.email, 1)}><ArrowDown size={14} /></IconButton>
                  <IconButton title="移除" className="danger" onClick={() => setForm((f) => ({ ...f, recipients: f.recipients.filter((_, i) => i !== r.index) }))}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
            {!rows.length && <p className="plan-empty">还没有收件人。可从上方编辑库加入，也可以粘贴、导入，或从别的计划带过来。</p>}
            {!!rows.length && !visible.length && <p className="plan-empty">没有符合当前筛选的收件人。</p>}
          </div>

          <div className="plan-send">
            <div className="plan-send-head">
              <div><span>04 · 发送安排</span><h3>设置何时、以多快的节奏发送</h3></div>
              <strong>{sendCount}<small>封待发送</small></strong>
            </div>
            <div className="plan-setting-row">
              <span>发送时间</span>
              <div className="plan-send-modes">
              {([
                ['immediate', '立即'],
                ['scheduled', '定时'],
                ['loop', '循环'],
              ] as const).map(([id, label]) => (
                <button type="button" key={id} className={taskForm.schedule_type === id ? 'on' : ''}
                  onClick={() => setTaskForm({ ...taskForm, schedule_type: id })}>{label}</button>
              ))}
              </div>
            </div>
            {taskForm.schedule_type === 'scheduled' && (
              <label className="plan-date-field"><span>预约时间</span><input type="datetime-local" value={scheduledInput} onChange={(e) => setScheduledInput(e.target.value)} /></label>
            )}
            <div className="plan-setting-row">
              <span>发送节奏</span>
              <div className="plan-send-modes">
              {([
                ['steady', '稳健'],
                ['balanced', '均衡'],
                ['fast', '尽快'],
              ] as const).map(([id, label]) => (
                <button type="button" key={id} className={pace === id ? 'on' : ''}
                  onClick={() => settings && applyPace(id, settings)}>{label}</button>
              ))}
              </div>
            </div>
            <div className="plan-estimate">
              <Clock3 size={16} />
              <div><strong>{sendCount > 0 ? `预计约 ${minutes} 分钟` : '等待添加收件人'}</strong><p>每封间隔 {formatDurationRange(taskForm.interval_min, taskForm.interval_max)}，每批 {taskForm.batch_size_min}–{taskForm.batch_size_max} 封。</p></div>
            </div>
            <label className="plan-skip-option">
              <input type="checkbox" checked={skipSent} onChange={(e) => setSkipSent(e.target.checked)} />
              <span><b>跳过已经投过的邮箱</b><small>避免同一作品重复投递给相同编辑部</small></span>
            </label>
            {!enabledAccounts.length && <p className="warn-text">还没有可用发件邮箱，只能先存草稿。</p>}
            <div className="plan-send-cta">
              <Clock3 size={14} />
              {taskForm.schedule_type === 'scheduled' ? '到点自动开始' : taskForm.schedule_type === 'loop' ? '按名单循环发送，需要时手动停止' : '保存后立即开始发送'}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
