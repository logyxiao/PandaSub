import { useRequestGuard } from '../hooks/useRequestGuard'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { useAttachmentImport } from '../hooks/useAttachmentImport'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileCheck2, FileText, FolderOpen, Plus, RefreshCw, Search, Share2, Trash2 } from 'lucide-react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import logoUrl from '../assets/logo.png'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton } from '../components/ui'
import { Table } from '../components/Table'
import type { AcceptedCandidate, AcceptedDealMode, AcceptedReviewStatus, AcceptedWork, AcceptedWorkSummary, AcceptedWorkInput, ManuscriptSummary } from '../types'
import { summarizeAcceptedSales } from './acceptedStats'
import { drawAcceptedShareCard } from './acceptedShareCard'

let shareLogoPromise: Promise<HTMLImageElement> | null = null
function loadShareLogo() {
  if (!shareLogoPromise) {
    shareLogoPromise = new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('熊猫投稿 Logo 加载失败'))
      image.src = logoUrl
    })
  }
  return shareLogoPromise
}

const today = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const yuan = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const moneyText = (cents: number) => cents ? (cents / 100).toFixed(2).replace(/\.00$/, '') : ''
const reviewOptions: [AcceptedReviewStatus, string][] = [
  ['accepted', '最终过稿'], ['preliminary', '过初审'], ['final_rejected', '未过终审'], ['not_accepted', '未过稿'],
]
const reviewLabel = (status: AcceptedReviewStatus) => reviewOptions.find(([value]) => value === status)?.[1] || '核对'

function emptyWork(source: 'plan' | 'external' = 'external'): AcceptedWorkInput {
  return {
    manuscript_id: null, source, review_status: 'accepted', title: '', body: '', file_name: '', remove_file: false,
    accepted_at: today(), deal_mode: 'undecided', price_cents: 0, guarantee_cents: 0, per_thousand_cents: 0, realized_share_cents: 0,
    monthly_settlements: [],
    share_percent: 50, sale_platform: '', buyer_editor: '', listing_platform: '', article_url: '', notes: '',
  }
}

function saleLabel(work: AcceptedWorkSummary) {
  if (work.review_status === 'not_accepted') return <span className="hint">不计入卖出</span>
  if (work.review_status === 'preliminary') return <span className="hint">等待终审</span>
  if (work.review_status === 'final_rejected') return <span className="hint">终审未通过</span>
  if (work.deal_mode === 'platform_share') {
    const settled = (work.monthly_settlements || []).reduce((sum, entry) => sum + entry.amount_cents, 0)
    return <>上架月结 <strong>{settled ? yuan(settled) : '待结算'}</strong><small>{work.monthly_settlements?.length || 0} 个月已记录 · 无固定价格</small></>
  }
  if (work.deal_mode === 'buyout' && work.price_cents <= 0) return <span className="hint">买断价待补</span>
  if (work.deal_mode === 'guarantee_share' && work.guarantee_cents <= 0 && work.per_thousand_cents <= 0) return <span className="hint">保底价待补</span>
  if (work.deal_mode === 'buyout') return <>买断 <strong>{yuan(work.price_cents)}</strong><small>{work.accepted_at || '日期待补'}</small></>
  if (work.deal_mode === 'guarantee_share') return <>{work.guarantee_cents > 0 ? '保底' : '千字单价'} <strong>{yuan(work.guarantee_cents || work.per_thousand_cents)}{work.guarantee_cents ? '' : '/千字'}</strong><small>{work.share_percent > 0 ? `${work.share_percent}% 分成` : '分成比例待补'} · {work.accepted_at || '日期待补'}</small></>
  return <span className="hint">价格待定</span>
}

function toCents(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return 0
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null
  const amount = Math.round(Number(trimmed) * 100)
  return Number.isSafeInteger(amount) ? amount : null
}

export function AcceptedView() {
  const [works, setWorks] = useState<AcceptedWorkSummary[]>([])
  const [candidates, setCandidates] = useState<AcceptedCandidate[]>([])
  const [manuscripts, setManuscripts] = useState<ManuscriptSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | AcceptedReviewStatus>('all')
  const [originFilter, setOriginFilter] = useState<'all' | 'manual' | 'historical_import'>('all')
  const [editing, setEditing] = useState<AcceptedWork | null>(null)
  const [showForm, setShowForm] = useState(false)
  const attachmentImport = useAttachmentImport(showForm)
  const [draft, setDraft] = useState<AcceptedWorkInput>(() => emptyWork())
  const [priceText, setPriceText] = useState('')
  const [guaranteeText, setGuaranteeText] = useState('')
  const [perThousandText, setPerThousandText] = useState('')
  const [realizedShareText, setRealizedShareText] = useState('')
  const [settlementRows, setSettlementRows] = useState<{ month: string; amount: string }[]>([])
  const [shareText, setShareText] = useState('50')
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ id: number; title: string; fileName: string; text: string; attachmentText: string; hasFile: boolean; articleUrl: string } | null>(null)
  const [previewing, setPreviewing] = useState<number | null>(null)
  const [openingSaved, setOpeningSaved] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareZoomed, setShareZoomed] = useState(false)
  const [shareSaving, setShareSaving] = useState(false)
  const shareCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const confirm = useConfirm()

  const listRequests = useRequestGuard()
  const editRequests = useRequestGuard()
  const previewRequests = useRequestGuard()
  const [editingId, setEditingId] = useState<number | null>(null)
  const savingRef = useRef(false)
  const draftMetadata = useMemo(() => { const { body, ...metadata } = draft; void body; return JSON.stringify(metadata) }, [draft])
  const snapshot = useMemo(() => JSON.stringify([draftMetadata, priceText, guaranteeText, perThousandText, realizedShareText, settlementRows, shareText]),
    [draftMetadata, priceText, guaranteeText, perThousandText, realizedShareText, settlementRows, shareText])
  const baseline = useRef(snapshot)
  const baselineBody = useRef(draft.body)
  const allowLeave = useUnsavedChanges(showForm && (snapshot !== baseline.current || draft.body !== baselineBody.current), saving,
    '当前过稿记录尚未保存，继续会丢弃作品内容和结算修改。')
  const closeForm = async () => {
    if (await allowLeave()) { editRequests.invalidate(); setShowForm(false) }
  }
  const closePreview = () => { previewRequests.invalidate(); setPreviewing(null); setPreview(null) }

  const load = useCallback(async () => {
    const request = listRequests.begin()
    setLoading(true)
    try {
      const [nextWorks, nextCandidates, nextManuscripts] = await Promise.all([
        api.listAcceptedWorks(true), api.listAcceptedCandidates(), api.listManuscripts(true),
      ])
      if (!listRequests.isCurrent(request)) return
      setWorks(nextWorks); setCandidates(nextCandidates); setManuscripts(nextManuscripts); setNotice('')
    } catch (error) { if (listRequests.isCurrent(request)) setNotice(String(error)) }
    finally { if (listRequests.isCurrent(request)) setLoading(false) }
  }, [listRequests])
  useEffect(() => { void load() }, [load])

  const availableManuscripts = useMemo(() => {
    const used = new Set(works.map((work) => work.manuscript_id).filter((id) => id !== null))
    return manuscripts.filter((manuscript) => !used.has(manuscript.id) || manuscript.id === editing?.manuscript_id)
  }, [works, manuscripts, editing])
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return works.filter((work) => (statusFilter === 'all' || work.review_status === statusFilter)
      && (originFilter === 'all' || (work.record_origin || 'manual') === originFilter)
      && (!needle || [work.title, work.sale_platform, work.buyer_editor, work.listing_platform]
      .join(' ').toLocaleLowerCase().includes(needle)))
  }, [works, query, statusFilter, originFilter])
  const summary = useMemo(() => summarizeAcceptedSales(works), [works])

  useEffect(() => {
    if (!shareOpen) return
    let active = true
    void Promise.all([loadShareLogo(), document.fonts.ready]).then(([logo]) => {
      if (active && shareCanvasRef.current) drawAcceptedShareCard(shareCanvasRef.current, summary, works, new Date(), logo)
    }).catch((error) => { if (active) toast(String(error), 'error') })
    return () => { active = false }
  }, [shareOpen, summary, works, toast])

  const openNew = async (source: 'plan' | 'external', candidate?: AcceptedCandidate, reviewStatus: AcceptedReviewStatus = 'accepted') => {
    if (!await allowLeave()) return
    editRequests.invalidate(); setEditingId(null)
    attachmentImport.release()
    setEditing(null)
    const nextDraft = { ...emptyWork(source), review_status: reviewStatus, manuscript_id: candidate?.manuscript_id ?? null,
      accepted_at: candidate?.received_at.slice(0, 10) || today(),
      sale_platform: candidate?.sale_platform ?? '', buyer_editor: candidate?.buyer_editor ?? '' }
    baselineBody.current = nextDraft.body
    baseline.current = JSON.stringify([JSON.stringify({ ...nextDraft, body: undefined }), '', '', '', '', [], '50'])
    setDraft(nextDraft)
    setPriceText(''); setGuaranteeText(''); setPerThousandText(''); setRealizedShareText(''); setSettlementRows([]); setShareText('50'); setShowForm(true)
  }
  const openEdit = async (summary: AcceptedWorkSummary) => {
    if (!await allowLeave()) return
    const request = editRequests.begin()
    setEditingId(summary.id)
    try {
      const work = await api.getAcceptedWork(summary.id)
      if (!editRequests.isCurrent(request)) return
      attachmentImport.release()
      setEditing(work)
      const nextDraft = {
        manuscript_id: work.manuscript_id, source: work.source, review_status: work.review_status,
        title: work.title, body: work.body,
        file_name: work.file_name, remove_file: false, accepted_at: work.accepted_at,
        deal_mode: work.deal_mode, price_cents: work.price_cents, guarantee_cents: work.guarantee_cents, per_thousand_cents: work.per_thousand_cents || 0,
        realized_share_cents: work.realized_share_cents,
        monthly_settlements: work.monthly_settlements || [],
        share_percent: work.share_percent, sale_platform: work.sale_platform, buyer_editor: work.buyer_editor,
        listing_platform: work.listing_platform, article_url: work.article_url, notes: work.notes,
      }
      const settlements = (work.monthly_settlements || []).map((entry) => ({ month: entry.month, amount: moneyText(entry.amount_cents) }))
      baselineBody.current = nextDraft.body
    baseline.current = JSON.stringify([JSON.stringify({ ...nextDraft, body: undefined }), moneyText(work.price_cents), moneyText(work.guarantee_cents), moneyText(work.per_thousand_cents || 0), moneyText(work.realized_share_cents), settlements, String(work.share_percent)])
      setDraft(nextDraft)
      setPriceText(moneyText(work.price_cents)); setGuaranteeText(moneyText(work.guarantee_cents))
      setPerThousandText(moneyText(work.per_thousand_cents || 0))
      setRealizedShareText(moneyText(work.realized_share_cents))
      setSettlementRows(settlements)
      setShareText(String(work.share_percent)); setShowForm(true)
    } catch (error) { if (editRequests.isCurrent(request)) toast(`记录读取失败：${String(error)}`, 'error') }
    finally { if (editRequests.isCurrent(request)) setEditingId(null) }
  }

  const readFile = async (file: File | null) => {
    if (!file) return
    if (fileRef.current) fileRef.current.value = ''
    try {
      const imported = await attachmentImport.stage(file, ['docx', 'txt'])
      if (!imported) return
      setDraft((current) => ({ ...current, file_name: file.name, file_data: null, file_token: imported.token, remove_file: false,
        title: current.title || file.name.replace(/\.[^.]+$/, '') }))
    } catch (error) { toast(String(error), 'error') }
  }

  const saveWork = async () => {
    if (savingRef.current) return
    if (attachmentImport.importing) { toast('请等待附件导入完成', 'warning'); return }
    if (draft.source === 'plan' && !draft.manuscript_id) { toast('请选择一份投稿计划', 'warning'); return }
    if (draft.source === 'external' && !draft.title.trim()) { toast('请填写作品名称', 'warning'); return }
    const price = draft.deal_mode === 'buyout' ? toCents(priceText) : 0
    const guarantee = draft.deal_mode === 'guarantee_share' ? toCents(guaranteeText) : 0
    const perThousand = draft.deal_mode === 'guarantee_share' ? toCents(perThousandText) : 0
    const realizedShare = draft.deal_mode === 'guarantee_share' ? toCents(realizedShareText) : 0
    if (price === null || guarantee === null || perThousand === null || realizedShare === null) { toast('金额最多保留两位小数，且不能为负数', 'warning'); return }
    const monthlySettlements = draft.deal_mode === 'platform_share' ? settlementRows.map((row) => ({ month: row.month, amount_cents: toCents(row.amount) })) : draft.monthly_settlements
    if (draft.deal_mode === 'platform_share') {
      if (!draft.listing_platform.trim()) { toast('请填写上架平台，例如知乎或番茄', 'warning'); return }
      if (monthlySettlements.some((entry) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(entry.month) || !entry.amount_cents)) {
        toast('请填写完整的结算月份和大于 0 元的收入', 'warning'); return
      }
      if (new Set(monthlySettlements.map((entry) => entry.month)).size !== monthlySettlements.length) {
        toast('同一个月份只能记录一笔月结收入', 'warning'); return
      }
    }
    if (draft.review_status === 'accepted' && ((draft.deal_mode === 'buyout' && !price)
      || (draft.deal_mode === 'guarantee_share' && !guarantee && !perThousand))) {
      toast('已卖出作品请填写买断价、保底价或千字单价', 'warning'); return
    }
    const share = Number(shareText)
    if (draft.deal_mode === 'guarantee_share' && (!Number.isFinite(share) || share < 0 || share > 100 || shareText.trim() === '')) {
      toast('分成比例应在 0–100% 之间', 'warning'); return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const input = { ...draft, price_cents: price, guarantee_cents: guarantee, per_thousand_cents: perThousand, realized_share_cents: realizedShare,
        monthly_settlements: monthlySettlements as { month: string; amount_cents: number }[],
        share_percent: draft.deal_mode === 'guarantee_share' ? share : 50 }
      if (editing) await api.updateAcceptedWork(editing.id, input)
      else await api.addAcceptedWork(input)
      setShowForm(false)
      await load()
      toast(editing ? '核对记录已更新' : `已记录为${reviewLabel(draft.review_status)}`, 'success')
    } catch (error) { toast(String(error), 'error') }
    finally { savingRef.current = false; setSaving(false) }
  }

  const remove = async (work: AcceptedWorkSummary) => {
    const ok = await confirm({ title: '移除过稿记录？',
      message: `将从过稿统计移除《${work.title}》及这里保存的文稿副本。原投稿计划不会删除。`,
      confirmLabel: '移除', tone: 'danger' })
    if (!ok) return
    try { await api.deleteAcceptedWork(work.id); await load(); toast('过稿记录已移除', 'success') }
    catch (error) { toast(String(error), 'error') }
  }

  const openDocument = async (work: AcceptedWorkSummary) => {
    const request = previewRequests.begin()
    setPreviewing(work.id)
    try {
      const doc = await api.getAcceptedWorkDocument(work.id)
      if (!previewRequests.isCurrent(request)) return
      const fileText = doc.attachment_text
      const showBody = work.source === 'external' && Boolean(doc.body.trim())
      setPreview({ id: work.id, title: doc.title, fileName: doc.file_name,
        text: showBody ? doc.body : fileText || doc.body,
        attachmentText: showBody ? fileText : '',
        hasFile: doc.has_file, articleUrl: work.article_url })
    } catch (error) { if (previewRequests.isCurrent(request)) toast(`文稿读取失败：${String(error)}`, 'error') }
    finally { if (previewRequests.isCurrent(request)) setPreviewing(null) }
  }

  const exportOriginal = async () => {
    if (!preview?.hasFile) return
    try {
      const extension = preview.fileName.toLowerCase().endsWith('.txt') ? 'txt' : 'docx'
      const path = await saveDialog({ title: '保存原始文稿', defaultPath: preview.fileName || `${preview.title}.${extension}`,
        filters: [{ name: '原始文稿', extensions: [extension] }] })
      if (!path) return
      const saved = await api.exportAcceptedWorkDocument(preview.id, path)
      toast(`文稿已保存到 ${saved}`, 'success')
    } catch (error) { toast(String(error), 'error') }
  }

  const openSavedDocument = async (id: number, source: 'accepted' | 'manuscript', reveal: boolean) => {
    if (openingSaved) return
    setOpeningSaved(true)
    try {
      await api.openSavedDocument(id, source, reveal)
      toast(reveal ? '已在文件夹中定位保存的文稿副本' : '已用默认程序打开保存的文稿副本', 'success')
    } catch (error) { toast(String(error), 'error') }
    finally { setOpeningSaved(false) }
  }

  const saveShareImage = async () => {
    const canvas = shareCanvasRef.current
    if (!canvas || shareSaving) return
    setShareSaving(true)
    try {
      const path = await saveDialog({ title: '保存成绩记录', defaultPath: `熊猫投稿-成绩记录-${today()}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
      if (!path) return
      const [logo] = await Promise.all([loadShareLogo(), document.fonts.ready])
      drawAcceptedShareCard(canvas, summary, works, new Date(), logo)
      const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) =>
        blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png'))
      const saved = await api.saveAcceptedShareImage(path, new Uint8Array(await image.arrayBuffer()))
      toast(`成绩记录已保存到 ${saved}`, 'success')
    } catch (error) { toast(String(error), 'error') }
    finally { setShareSaving(false) }
  }

  return <div className="accepted-page">
    <div className="accepted-topline">
      <p>核对邮件结果，记录初审、终审与作品卖出情况。</p>
      <div className="toolbar-actions">
        <IconButton title="刷新过稿信息" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /></IconButton>
        <Button onClick={() => { setShareZoomed(false); setShareOpen(true) }}><Share2 size={15} />分享成绩</Button>
        <Button onClick={() => openNew('plan')} disabled={!availableManuscripts.length}><FileCheck2 size={15} />关联投稿计划</Button>
        <Button variant="primary" onClick={() => openNew('external')}><Plus size={15} />新增外部文章</Button>
      </div>
    </div>
    {notice && <div className="notice notice-error">{notice}</div>}
    <div className="accepted-summary">
      <div><span>近 7 天新增成交 / 上架</span><strong>{summary.last7Days.count}</strong><small>直接成交已知金额 {yuan(summary.last7Days.cents)}</small></div>
      <div><span>近 30 天新增成交 / 上架</span><strong>{summary.last30Days.count}</strong><small>直接成交已知金额 {yuan(summary.last30Days.cents)}</small></div>
      <div><span>累计成交 / 上架</span><strong>{summary.soldCount}</strong><small>直接成交 {summary.directCount} · 平台上架 {summary.platformShareCount}</small></div>
      <div><span>累计已记录金额</span><strong>{yuan(summary.totalCents)}</strong><small>成交价＋平台已结算 {yuan(summary.platformShareCents)}{summary.unpricedSoldCount ? ` · ${summary.unpricedSoldCount} 篇总价待核算` : ''}</small></div>
    </div>
    <div className="accepted-review-totals">初审通过 <strong>{summary.preliminaryCount}</strong> 篇 · 最终过稿 <strong>{summary.acceptedCount}</strong> 篇 · 未过终审 <strong>{summary.finalRejectedCount}</strong> 篇 · 未过稿 <strong>{summary.notAcceptedCount}</strong> 篇
      {summary.undatedSoldCount > 0 && <span> · {summary.undatedSoldCount} 篇已卖作品待补日期，暂不计入近期趋势</span>}</div>

    {candidates.length > 0 && <section className="panel accepted-candidates">
      <div className="accepted-section-head"><div><h2>待核对的邮件结果</h2><p>自动识别可能只代表初审通过，也可能误判；请选择实际结果。</p></div><Badge tone="warning">{candidates.length} 篇待核对</Badge></div>
      <div className="accepted-candidate-list">
        {candidates.map((candidate) => <div className="accepted-candidate" key={candidate.manuscript_id}>
          <div><strong>{candidate.title}</strong><small>{[candidate.sale_platform, candidate.buyer_editor, candidate.received_at.slice(0, 10)].filter(Boolean).join(' · ')}</small>
            {manuscripts.find((manuscript) => manuscript.id === candidate.manuscript_id)?.has_file && <span className="accepted-candidate-document">
              <button type="button" disabled={openingSaved} onClick={() => void openSavedDocument(candidate.manuscript_id, 'manuscript', false)}>打开 Word</button>
              <button type="button" disabled={openingSaved} onClick={() => void openSavedDocument(candidate.manuscript_id, 'manuscript', true)}>原稿文件夹</button>
            </span>}
          </div>
          <div className="accepted-candidate-actions">
            <Button size="sm" variant="primary" onClick={() => openNew('plan', candidate, 'accepted')}>最终过稿</Button>
            <Button size="sm" onClick={() => openNew('plan', candidate, 'preliminary')}>过初审</Button>
            <Button size="sm" variant="subtle" onClick={() => openNew('plan', candidate, 'final_rejected')}>未过终审</Button>
            <Button size="sm" variant="subtle" onClick={() => openNew('plan', candidate, 'not_accepted')}>未过</Button>
          </div>
        </div>)}
      </div>
    </section>}

    <div className="accepted-channel-overview">
      <div><span>直接卖给第三方</span><strong>{summary.directCount} 篇</strong><small>买断 {summary.buyoutCount} · 保底加分成 {summary.guaranteeShareCount}</small><b>{yuan(summary.directCents)}</b><em>已知成交金额</em></div>
      <div><span>上架平台按月分成</span><strong>{summary.platformShareCount} 篇</strong><small>知乎、番茄等平台 · {summary.platformPaidCount} 篇已有月结</small><b>{yuan(summary.platformShareCents)}</b><em>历月已结算收入</em></div>
    </div>
    {summary.platformMonths.length > 0 && <section className="panel accepted-monthly-panel">
      <div className="accepted-section-head"><div><h2>平台月结</h2><p>按结算月份汇总，知乎等平台的后续分成会持续累加。</p></div></div>
      <div className="accepted-monthly-list">{summary.platformMonths.slice(0, 6).map((row) => <div className="accepted-monthly-item" key={row.month}>
        <time>{row.month}</time><span>{row.platforms.map((item) => `${item.platform} ${yuan(item.cents)}`).join(' · ')}</span><strong>{yuan(row.totalCents)}</strong>
      </div>)}</div>
    </section>}
    <section className="panel accepted-sales-panel">
      <div className="accepted-section-head"><div><h2>渠道成绩</h2><p>直接成交按已知价格汇总；平台上架按已录入的月结收入汇总。</p></div>
        <span className="accepted-sales-lead">累计 <strong>{summary.soldCount}</strong> 篇 · 已记录 <strong>{yuan(summary.totalCents)}</strong></span></div>
      {summary.platforms.length ? <Table className="accepted-sales-table" rowKey={(row) => `${row.channel}:${row.platform}`} dataSource={summary.platforms} minWidth={650}
        columns={[
          { key: 'platform', title: '渠道 / 平台', render: (_value, row) => <div className="accepted-sales-platform"><span>{row.channel === 'platform' ? '平台上架' : '第三方成交'}</span><strong>{row.platform}</strong></div> },
          { key: 'count', title: '篇数', width: 90, render: (_value, row) => `${row.count} 篇` },
          { key: 'modes', title: '出售方式', width: 210, render: (_value, row) => row.channel === 'platform' ? '按月分成' : `买断 ${row.buyout} · 保底分成 ${row.guaranteeShare}` },
          { key: 'amount', title: '已记录金额', width: 140, align: 'right', render: (_value, row) => <strong>{yuan(row.totalCents)}</strong> },
        ]} /> : <div className="accepted-sales-empty">记录直接成交或平台上架后，这里会按渠道汇总篇数与收入。</div>}
    </section>

    <section className="panel accepted-list-panel">
      <div className="accepted-section-head accepted-list-head">
        <div><h2>作品核对记录</h2><p>初审通过后可继续记录最终过稿或未过终审。</p></div>
        <label className="accepted-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索作品或平台" aria-label="搜索过稿作品" /></label>
      </div>
      <div className="accepted-status-filters" role="group" aria-label="核对状态筛选">
        {([['all', '全部'], ['preliminary', '过初审'], ['accepted', '最终过稿'], ['final_rejected', '未过终审'], ['not_accepted', '未过稿']] as const).map(([value, label]) =>
          <button key={value} type="button" className={statusFilter === value ? 'on' : ''} aria-pressed={statusFilter === value}
            onClick={() => setStatusFilter(value)}>{label}</button>)}
        <select className="accepted-origin-filter" aria-label="记录来源筛选" value={originFilter}
          onChange={(event) => setOriginFilter(event.target.value as typeof originFilter)}>
          <option value="all">全部来源</option>
          <option value="manual">原有记录</option>
          <option value="historical_import">历史导入</option>
        </select>
        <span>{visible.length} 篇</span>
      </div>
      {!loading && !works.length ? <EmptyState icon={FileCheck2} title="还没有核对记录"
        desc="可从待核对回复中选择实际结果，也可以录入外部文章。"
        action={<Button variant="primary" onClick={() => openNew('external')}><Plus size={15} />新增外部文章</Button>} /> :
        <Table className="accepted-table" rowKey="id" dataSource={visible} minWidth={900}
          resetKey={`${query}:${statusFilter}:${originFilter}`} empty="没有找到符合条件的作品" pagination={{ pageSize: 8, pageSizeOptions: [8, 20, 50], hideOnSinglePage: true }}
          columns={[
            { key: 'title', title: '作品', render: (_value, work) => <div className="accepted-title"><span className="accepted-title-line"><strong>{work.title}</strong><Badge tone={work.review_status === 'accepted' ? 'success' : work.review_status === 'preliminary' ? 'info' : work.review_status === 'final_rejected' ? 'warning' : 'neutral'}>{reviewLabel(work.review_status)}</Badge>{work.record_origin === 'historical_import' && <Badge tone="info">历史导入</Badge>}</span><small>{work.source === 'plan' ? '投稿计划' : '外部文章'} · {work.accepted_at || '未填写核对日期'}</small></div> },
            { key: 'sale', title: '价格 / 结算', width: 185, render: (_value, work) => <div className="accepted-sale">{saleLabel(work)}</div> },
            { key: 'buyer', title: '渠道 / 平台', width: 190, render: (_value, work) => <div className="accepted-meta"><span>{work.review_status !== 'accepted' ? work.sale_platform || '邮件平台待核对' : work.deal_mode === 'platform_share' ? `平台上架 · ${work.listing_platform || '待填平台'}` : `第三方成交 · ${work.sale_platform || '待填平台'}`}</span><small>{work.review_status !== 'accepted' ? work.buyer_editor || '编辑待核对' : work.deal_mode === 'platform_share' ? `${work.monthly_settlements?.length || 0} 个月已结算` : [work.buyer_editor, work.listing_platform && `卖家上架 ${work.listing_platform}`].filter(Boolean).join(' · ') || '未填买家编辑'}</small></div> },
            { key: 'actions', title: '操作', width: 220, render: (_value, work) => <div className="accepted-actions">
              <Button size="sm" disabled={previewing === work.id} onClick={() => void openDocument(work)}><FileText size={14} />{previewing === work.id ? '读取中…' : '查看文稿'}</Button>
              <IconButton title="打开文稿所在文件夹" disabled={!work.has_file || openingSaved} onClick={() => void openSavedDocument(work.id, 'accepted', true)}><FolderOpen size={14} /></IconButton>
              <Button size="sm" variant="subtle" disabled={editingId === work.id} onClick={() => void openEdit(work)}>编辑</Button>
              <IconButton title="移除过稿记录" className="danger" onClick={() => void remove(work)}><Trash2 size={14} /></IconButton>
            </div> },
          ]} />}
    </section>

    {showForm && <Modal title={editing ? `编辑核对记录 · ${editing.title}` : '核对作品结果'} width={760}
      className="accepted-modal" onClose={() => void closeForm()}
      footer={<><Button onClick={() => void closeForm()} disabled={saving}>取消</Button><Button variant="primary" disabled={saving} onClick={() => void saveWork()}>{saving ? '保存中…' : `保存${reviewLabel(draft.review_status)}记录`}</Button></>}>
      <fieldset className="accepted-form" disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {!editing && <div className="accepted-source-switch" role="group" aria-label="作品来源">
          <button type="button" className={draft.source === 'plan' ? 'on' : ''} onClick={() => openNew('plan')}>软件内投稿</button>
          <button type="button" className={draft.source === 'external' ? 'on' : ''} onClick={() => openNew('external')}>外部文章</button>
        </div>}
        <div className="accepted-form-section accepted-review-section"><h3>实际核对结果</h3>
          <div className="accepted-review-row">
            <div className="accepted-review-switch" role="group" aria-label="核对结果">
              {reviewOptions.map(([status, label]) =>
                <button key={status} type="button" className={draft.review_status === status ? 'on' : ''} aria-pressed={draft.review_status === status}
                  onClick={() => setDraft((current) => ({ ...current, review_status: status }))}>{label}</button>)}
            </div>
            <label className="field accepted-review-date">{draft.review_status === 'accepted' ? '过稿日期' : draft.review_status === 'preliminary' ? '初审日期' : draft.review_status === 'final_rejected' ? '终审日期' : '核对日期'}<input type="date" value={draft.accepted_at} onChange={(event) => setDraft((current) => ({ ...current, accepted_at: event.target.value }))} /></label>
          </div>
          <p className="field-hint">初审通过后，终审有结果时可改为最终过稿或未过终审；邮件识别错误请选未过稿。</p>
        </div>
        <div className="accepted-form-grid">
          {draft.source === 'plan' ? <label className="field accepted-span-all">关联投稿计划
            <select value={draft.manuscript_id ?? ''} disabled={Boolean(editing)} onChange={(event) => setDraft((current) => ({ ...current, manuscript_id: Number(event.target.value) || null }))}>
              <option value="">选择作品</option>
              {availableManuscripts.map((manuscript) => <option key={manuscript.id} value={manuscript.id}>{manuscript.title}</option>)}
            </select>
            <span className="field-hint">加入时会保存作品正文和原始附件的副本。</span>
          </label> : <>
            <label className="field accepted-span-all">作品名称<input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="例如：山海之间" /></label>
            <label className="field accepted-span-all">文章正文<textarea rows={4} value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} placeholder="可粘贴正文；也可以只上传 Word 文稿" /></label>
            <div className="accepted-file-row accepted-span-all">
              <input ref={fileRef} type="file" accept=".docx,.txt" hidden onChange={(event) => void readFile(event.target.files?.[0] ?? null)} />
              <Button type="button" onClick={() => fileRef.current?.click()}><FileText size={14} />{draft.file_name ? '替换文稿' : '上传 Word 文稿'}</Button>
              <span>{draft.file_name || '支持 .docx / .txt，最多 25 MB'}</span>
              {draft.file_name && <button type="button" className="text-link" onClick={() => { attachmentImport.release(); setDraft((current) => ({ ...current, file_name: '', file_data: null, file_token: null, remove_file: true })) }}>移除附件</button>}
            </div>
          </>}
        </div>

        {draft.review_status === 'accepted' && <div className="accepted-form-section"><h3>价格与出售方式</h3>
          <div className="accepted-mode-groups" role="group" aria-label="出售方式">
            <div className="accepted-mode-group"><span>直接卖给第三方</span><div className="accepted-mode-switch">
              {([['buyout', '买断'], ['guarantee_share', '保底加分成']] as [AcceptedDealMode, string][]).map(([mode, label]) =>
                <button key={mode} type="button" className={draft.deal_mode === mode ? 'on' : ''} aria-pressed={draft.deal_mode === mode}
                  onClick={() => setDraft((current) => ({ ...current, deal_mode: mode }))}>{label}</button>)}
            </div></div>
            <div className="accepted-mode-group"><span>上架平台</span><div className="accepted-mode-switch">
              <button type="button" className={draft.deal_mode === 'platform_share' ? 'on' : ''} aria-pressed={draft.deal_mode === 'platform_share'}
                onClick={() => setDraft((current) => ({ ...current, deal_mode: 'platform_share' }))}>按月分成</button>
            </div></div>
            <button type="button" className={`accepted-mode-undecided${draft.deal_mode === 'undecided' ? ' on' : ''}`} aria-pressed={draft.deal_mode === 'undecided'}
              onClick={() => setDraft((current) => ({ ...current, deal_mode: 'undecided' }))}>暂未定价</button>
          </div>
          {draft.deal_mode === 'buyout' && <label className="field">买断价格（元）<input type="text" inputMode="decimal" value={priceText} onChange={(event) => setPriceText(event.target.value)} placeholder="例如 5000" /></label>}
          {draft.deal_mode === 'guarantee_share' && <div className="accepted-form-grid">
            <label className="field">保底总价（元）<input type="text" inputMode="decimal" value={guaranteeText} onChange={(event) => setGuaranteeText(event.target.value)} placeholder="例如 3000；按千字计价可留空" /></label>
            <label className="field">千字单价（元）<input type="text" inputMode="decimal" value={perThousandText} onChange={(event) => setPerThousandText(event.target.value)} placeholder="例如 30；无千字单价可留空" /></label>
            <label className="field">作者分成比例（%）<input type="number" min={0} max={100} step="0.1" value={shareText} onChange={(event) => setShareText(event.target.value)} /></label>
            <label className="field">已结算分成（元）<input type="text" inputMode="decimal" value={realizedShareText} onChange={(event) => setRealizedShareText(event.target.value)} placeholder="尚未结算可留空" /></label>
            <p className="field-hint accepted-span-all">总价与千字单价至少填一项。只知道千字单价时仍计入卖出篇数，累计金额暂不估算；新记录作者分成默认 50%，历史记录的 0% 表示比例待补。</p>
          </div>}
          {draft.deal_mode === 'platform_share' && <div className="accepted-settlements">
            <p className="field-hint">没有固定价格。作品计入平台上架篇数；每月拿到分成后，再记录当月实际收入。</p>
            <div className="accepted-settlement-head"><strong>月结记录</strong><Button size="sm" type="button" onClick={() => setSettlementRows((rows) => [...rows, { month: '', amount: '' }])}><Plus size={13} />添加月份</Button></div>
            {settlementRows.length ? settlementRows.map((row, index) => <div className="accepted-settlement-row" key={index}>
              <label className="field">结算月份<input type="month" value={row.month} onChange={(event) => setSettlementRows((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, month: event.target.value } : item))} /></label>
              <label className="field">实际收入（元）<input type="text" inputMode="decimal" value={row.amount} placeholder="例如 320.50" onChange={(event) => setSettlementRows((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, amount: event.target.value } : item))} /></label>
              <IconButton title="删除这月结算" className="danger" onClick={() => setSettlementRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={14} /></IconButton>
            </div>) : <span className="accepted-settlement-empty">尚未结算时可以留空，之后编辑作品补记。</span>}
          </div>}
        </div>}

        <div className="accepted-form-section"><h3>{draft.deal_mode === 'platform_share' ? '上架信息' : '平台与买家'}</h3>
          <div className="accepted-form-grid">
            {draft.deal_mode !== 'platform_share' && <><label className="field">卖出平台<input value={draft.sale_platform} onChange={(event) => setDraft((current) => ({ ...current, sale_platform: event.target.value }))} placeholder="例如：知乎盐选" /></label>
            <label className="field">买家编辑<input value={draft.buyer_editor} onChange={(event) => setDraft((current) => ({ ...current, buyer_editor: event.target.value }))} placeholder="编辑姓名或联系方式" /></label></>}
            <label className="field">{draft.deal_mode === 'platform_share' ? '上架平台' : '卖家上架平台'}<input value={draft.listing_platform} onChange={(event) => setDraft((current) => ({ ...current, listing_platform: event.target.value }))} placeholder="例如：知乎、番茄小说" /></label>
            <label className="field">文章链接（可选）<input type="url" value={draft.article_url} onChange={(event) => setDraft((current) => ({ ...current, article_url: event.target.value }))} placeholder="https://" /></label>
            <label className="field accepted-span-all">备注<textarea rows={2} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="合同、结算时间或其他需要记住的信息" /></label>
          </div>
        </div>
      </fieldset>
    </Modal>}

    {shareOpen && <Modal title="分享成交与上架记录" width={1040} className="accepted-share-modal" onClose={() => { if (!shareSaving) setShareOpen(false) }}
      footer={<><span>最多展示最近 8 篇成交或上架作品的日期、平台、方式与已知收入，不包含作品名、买家编辑或备注原文。{summary.undatedSoldCount > 0 ? `另有 ${summary.undatedSoldCount} 篇未填日期，暂未计入近期曲线。` : ''}</span><Button onClick={() => setShareZoomed((value) => !value)}>{shareZoomed ? '适应窗口' : '放大查看'}</Button><Button onClick={() => setShareOpen(false)} disabled={shareSaving}>关闭</Button><Button variant="primary" disabled={shareSaving} onClick={() => void saveShareImage()}><Download size={15} />{shareSaving ? '生成中…' : '保存 PNG 图片'}</Button></>}>
      <canvas ref={shareCanvasRef} width={1440} height={1080} className={`accepted-share-canvas${shareZoomed ? ' is-zoomed' : ''}`} role="img"
        aria-label={`熊猫投稿成交与上架记录：近 7 天新增 ${summary.last7Days.count} 篇，近 30 天新增 ${summary.last30Days.count} 篇，累计已记录金额 ${yuan(summary.totalCents)}`} />
    </Modal>}

    {preview && <Modal title={`文稿 · ${preview.title}`} width={860} className="accepted-preview-modal" onClose={closePreview}
      footer={<><span>{preview.fileName || '无原始附件'}</span>{preview.hasFile && <>
        <Button disabled={openingSaved} onClick={() => void openSavedDocument(preview.id, 'accepted', true)}><FolderOpen size={15} />打开文件夹</Button>
        <Button disabled={openingSaved} onClick={() => void openSavedDocument(preview.id, 'accepted', false)}><FileText size={15} />打开原稿</Button>
        <Button onClick={() => void exportOriginal()}><Download size={15} />另存原稿</Button>
      </>}<Button variant="primary" onClick={closePreview}>关闭</Button></>}>
      {preview.hasFile && /\.docx$/i.test(preview.fileName) && <p className="accepted-preview-note">{preview.attachmentText ? '下方可展开 Word 文本；打开原稿可查看完整排版。' : '这里显示 Word 文本；打开原稿可查看完整排版。'}</p>}
      {!preview.hasFile && <p className="accepted-preview-note">这篇作品没有原始文稿附件，以下为保存的正文。</p>}
      {preview.articleUrl && <p className="accepted-preview-link">文章链接：<a href={preview.articleUrl} target="_blank" rel="noopener noreferrer">{preview.articleUrl}</a></p>}
      <article className="accepted-preview-text">{preview.text.trim() || '这篇作品没有可预览的文字内容。'}</article>
      {preview.attachmentText && <details className="accepted-preview-attachment"><summary>查看上传的原始文稿文字</summary><article className="accepted-preview-text">{preview.attachmentText}</article></details>}
    </Modal>}
  </div>
}
