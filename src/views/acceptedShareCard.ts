import type { AcceptedWorkSummary } from '../types'
import type { AcceptedSalesSummary } from './acceptedStats'

const c = {
  canvas: '#F5F6F5', surface: '#FFFFFF', header: '#FAFBF9', stripe: '#FCFDFC',
  ink: '#29312D', muted: '#829087', border: '#E3E8E3',
  accent: '#718B7A', soft: '#EDF1EE', brand: '#303936',
}
const sans = '"PingFang SC", "Microsoft YaHei", sans-serif'
const dataFont = '"Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
const money = (cents: number) => '¥' + (cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const amount = (cents: number) => (cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })

export function recentSaleRows(works: AcceptedWorkSummary[]) {
  return works.filter((work) => work.review_status === 'accepted'
    && (work.deal_mode === 'buyout' ? work.price_cents > 0
      : work.deal_mode === 'guarantee_share' ? (work.guarantee_cents > 0 || work.per_thousand_cents > 0)
      : work.deal_mode === 'platform_share'))
    .sort((a, b) => (b.accepted_at || '').localeCompare(a.accepted_at || '') || b.id - a.id)
    .slice(0, 8)
}

function fitText(ctx: CanvasRenderingContext2D, value: string, width: number) {
  if (ctx.measureText(value).width <= width) return value
  let result = value
  while (result.length && ctx.measureText(result + '…').width > width) result = result.slice(0, -1)
  return result + '…'
}

function fitSize(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, initial: number) {
  let size = initial
  do {
    ctx.font = '700 ' + size + 'px ' + dataFont
    if (ctx.measureText(value).width <= maxWidth) break
    size--
  } while (size > 18)
}

function rule(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.strokeStyle = c.border
  ctx.lineWidth = 1
  ctx.stroke()
}

export function drawAcceptedShareCard(
  canvas: HTMLCanvasElement,
  summary: AcceptedSalesSummary,
  works: AcceptedWorkSummary[],
  date: Date,
  logo: HTMLImageElement,
) {
  const rows = recentSaleRows(works)
  const rowSlots = Math.max(3, rows.length)
  const compactBy = (8 - rowSlots) * 55
  const targetHeight = 1080 - compactBy
  if (canvas.height !== targetHeight) canvas.height = targetHeight
  canvas.dataset.ready = 'false'
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = c.canvas
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = c.surface
  ctx.fillRect(24, 24, width - 48, height - 48)
  ctx.strokeStyle = c.border
  ctx.lineWidth = 1
  ctx.strokeRect(24.5, 24.5, width - 49, height - 49)

  ctx.drawImage(logo, 48, 43, 80, 80)
  ctx.fillStyle = c.ink
  ctx.font = '700 42px ' + sans
  ctx.fillText('熊猫投稿', 145, 100)
  rule(ctx, 345, 58, 345, 112)
  ctx.fillStyle = '#596E60'
  ctx.font = '650 36px ' + sans
  ctx.fillText('成交与上架记录', 372, 98)
  ctx.textAlign = 'right'
  ctx.fillStyle = c.muted
  ctx.font = '500 23px ' + dataFont
  const dateLabel = date.getFullYear() + '.' + String(date.getMonth() + 1).padStart(2, '0')
    + '.' + String(date.getDate()).padStart(2, '0')
  ctx.fillText('截至 ' + dateLabel, 1390, 97)

  ctx.font = '500 18px ' + sans
  ctx.fillText(rows.length ? '最近 ' + rows.length + ' 篇成交 / 上架' : '暂无成交或上架记录', 1390, 151)
  ctx.textAlign = 'left'

  const x = [40, 164, 336, 570, 770, 1030, 1400]
  const tableTop = 167, headerHeight = 62, rowHeight = 55
  const tableBottom = tableTop + headerHeight + rowHeight * rowSlots
  ctx.fillStyle = c.header
  ctx.fillRect(x[0], tableTop, x[6] - x[0], headerHeight)
  for (let index = 0; index < rowSlots; index++) {
    if (index % 2) {
      ctx.fillStyle = c.stripe
      ctx.fillRect(x[0], tableTop + headerHeight + index * rowHeight, x[6] - x[0], rowHeight)
    }
  }
  ctx.strokeStyle = c.border
  ctx.strokeRect(x[0] + 0.5, tableTop + 0.5, x[6] - x[0] - 1, tableBottom - tableTop - 1)
  for (const edge of x.slice(1, -1)) rule(ctx, edge + 0.5, tableTop, edge + 0.5, tableBottom)
  for (let index = 0; index < rowSlots; index++) {
    const y = tableTop + headerHeight + index * rowHeight + 0.5
    rule(ctx, x[0], y, x[6], y)
  }

  const centers = x.slice(0, -1).map((start, index) => (start + x[index + 1]) / 2)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#45564B'
  ctx.font = '600 25px ' + sans
  ;['序号', '日期', '渠道', '价格', '模式', '备注'].forEach((label, index) =>
    ctx.fillText(label, centers[index], tableTop + headerHeight / 2))

  rows.forEach((work, index) => {
    const y = tableTop + headerHeight + index * rowHeight + rowHeight / 2
    ctx.fillStyle = c.ink
    ctx.font = '500 24px ' + dataFont
    ctx.fillText(String(index + 1).padStart(2, '0'), centers[0], y)
    ctx.font = '500 22px ' + dataFont
    ctx.fillStyle = work.accepted_at ? c.ink : c.muted
    ctx.fillText(work.accepted_at ? work.accepted_at.slice(5).replace('-', '.') : '待补日期', centers[1], y)
    ctx.fillStyle = c.ink
    ctx.font = '500 22px ' + sans
    ctx.fillText(fitText(ctx, (work.deal_mode === 'platform_share' ? work.listing_platform : work.sale_platform).trim() || '未填写平台', x[3] - x[2] - 32), centers[2], y)
    ctx.font = '600 24px ' + dataFont
    const price = work.deal_mode === 'platform_share' ? '按月结算'
      : work.deal_mode === 'buyout' ? amount(work.price_cents)
      : work.guarantee_cents > 0 ? amount(work.guarantee_cents) : amount(work.per_thousand_cents) + '/千字'
    ctx.fillText(price, centers[3], y)
    ctx.font = '500 22px ' + sans
    ctx.fillText(work.deal_mode === 'buyout' ? '买断' : work.deal_mode === 'platform_share' ? '平台上架' : '保底＋分成', centers[4], y)
    if (work.deal_mode === 'platform_share') {
      const settled = (work.monthly_settlements || []).reduce((sum, entry) => sum + entry.amount_cents, 0)
      ctx.textAlign = 'left'
      ctx.fillStyle = c.muted
      ctx.font = '500 20px ' + sans
      ctx.fillText(fitText(ctx, settled > 0 ? `${work.monthly_settlements.length} 个月 · 已结算 ${money(settled)}` : '待首笔月结', x[6] - x[5] - 36), x[5] + 18, y)
      ctx.textAlign = 'center'
    } else if (work.deal_mode === 'guarantee_share') {
      ctx.textAlign = 'left'
      ctx.fillStyle = c.muted
      ctx.font = '500 20px ' + sans
      const note = work.guarantee_cents <= 0 ? '总价待核算' + (work.share_percent > 0 ? ' · 分成 ' + work.share_percent + '%' : ' · 比例待补')
        : work.realized_share_cents > 0
        ? '分成 ' + work.share_percent + '% · 已结算 ' + money(work.realized_share_cents)
        : work.share_percent > 0 ? '分成 ' + work.share_percent + '%' : '分成比例待补'
      ctx.fillText(fitText(ctx, note, x[6] - x[5] - 36), x[5] + 18, y)
      ctx.textAlign = 'center'
    }
  })
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  const statsY = 692 - compactBy, statsH = 126, statsRight = 1098
  const cellWidth = (statsRight - x[0]) / 5
  ctx.fillStyle = c.surface
  ctx.fillRect(x[0], statsY, statsRight - x[0], statsH)
  ctx.strokeStyle = c.border
  ctx.strokeRect(x[0] + 0.5, statsY + 0.5, statsRight - x[0] - 1, statsH - 1)
  const stats = [
    ['近 7 天', summary.last7Days.count],
    ['近 30 天', summary.last30Days.count],
    ['累计成交 / 上架', summary.soldCount],
    ['直接成交', summary.directCount],
    ['平台上架', summary.platformShareCount],
  ] as const
  stats.forEach(([label, value], index) => {
    const start = x[0] + index * cellWidth
    if (index) rule(ctx, start + 0.5, statsY + 20, start + 0.5, statsY + statsH - 20)
    ctx.fillStyle = c.muted
    ctx.font = '550 22px ' + sans
    ctx.fillText(label, start + 19, statsY + 43)
    ctx.fillStyle = c.ink
    ctx.font = '700 42px ' + dataFont
    ctx.fillText(String(value), start + 19, statsY + 99)
    const numberWidth = ctx.measureText(String(value)).width
    ctx.font = '600 23px ' + sans
    ctx.fillText('篇', start + 25 + numberWidth, statsY + 96)
  })
  ctx.fillStyle = c.brand
  ctx.fillRect(statsRight + 8, statsY, x[6] - statsRight - 8, statsH)
  ctx.fillStyle = c.soft
  ctx.font = '550 22px ' + sans
  ctx.fillText('累计已记录金额', statsRight + 28, statsY + 42)
  const total = money(summary.totalCents)
  ctx.fillStyle = c.surface
  fitSize(ctx, total, x[6] - statsRight - 54, 47)
  ctx.fillText(total, statsRight + 26, statsY + 101)

  ctx.fillStyle = c.ink
  ctx.font = '600 23px ' + sans
  ctx.fillText('近 30 天新增成交 / 上架', 48, 868 - compactBy)
  ctx.textAlign = 'right'
  ctx.fillStyle = c.muted
  ctx.font = '500 18px ' + sans
  ctx.fillText(summary.undatedSoldCount
      ? summary.undatedSoldCount + ' 笔过稿记录未填写日期，未计入趋势'
    : summary.unpricedSoldCount
      ? summary.unpricedSoldCount + ' 笔按千字计价，总价未计入金额'
      : '按过稿日期统计篇数 · 金额含平台已结算月收', 1392, 867 - compactBy)
  ctx.textAlign = 'left'

  const plot = { left: 88, right: 1380, top: 909 - compactBy, bottom: 1006 - compactBy }
  const max = Math.max(summary.last30Days.count, 1)
  rule(ctx, plot.left, plot.top + 0.5, plot.right, plot.top + 0.5)
  rule(ctx, plot.left, (plot.top + plot.bottom) / 2 + 0.5, plot.right, (plot.top + plot.bottom) / 2 + 0.5)
  rule(ctx, plot.left, plot.bottom + 0.5, plot.right, plot.bottom + 0.5)
  const points = summary.dailyCumulative.map((day, index) => ({
    x: plot.left + index * (plot.right - plot.left) / 29,
    y: plot.bottom - day.count / max * (plot.bottom - plot.top),
  }))
  if (points.length) {
    ctx.beginPath()
    ctx.moveTo(points[0].x, plot.bottom)
    ctx.lineTo(points[0].x, points[0].y)
    for (let index = 1; index < points.length; index++) {
      ctx.lineTo(points[index].x, points[index - 1].y)
      ctx.lineTo(points[index].x, points[index].y)
    }
    ctx.lineTo(points[points.length - 1].x, plot.bottom)
    ctx.closePath()
    ctx.fillStyle = 'rgba(113, 139, 122, 0.12)'
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let index = 1; index < points.length; index++) {
      ctx.lineTo(points[index].x, points[index - 1].y)
      ctx.lineTo(points[index].x, points[index].y)
    }
    ctx.strokeStyle = c.accent
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.stroke()
    const last = points[points.length - 1]
    ctx.beginPath()
    ctx.arc(last.x, last.y, 6, 0, Math.PI * 2)
    ctx.fillStyle = c.accent
    ctx.fill()
  }
  ctx.fillStyle = c.muted
  ctx.font = '500 17px ' + dataFont
  ctx.textAlign = 'right'
  ctx.fillText(String(max), plot.left - 15, plot.top + 6)
  ctx.fillText('0', plot.left - 15, plot.bottom + 6)
  ctx.textAlign = 'left'
  ctx.fillText(summary.dailyCumulative[0]?.date.slice(5).replace('-', '.') || '', plot.left, 1034 - compactBy)
  ctx.textAlign = 'right'
  ctx.fillText(summary.dailyCumulative[29]?.date.slice(5).replace('-', '.') || '', plot.right, 1034 - compactBy)
  ctx.textAlign = 'left'
  canvas.dataset.ready = 'true'
}
