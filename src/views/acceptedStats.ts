import type { AcceptedWork } from '../types'

export interface PlatformSaleRow {
  platform: string
  count: number
  buyout: number
  guaranteeShare: number
  totalCents: number
}

export interface SalesWindow { count: number; cents: number }

export interface AcceptedSalesSummary {
  preliminaryCount: number
  acceptedCount: number
  finalRejectedCount: number
  notAcceptedCount: number
  soldCount: number
  buyoutCount: number
  guaranteeShareCount: number
  totalCents: number
  realizedShareCents: number
  undatedSoldCount: number
  unpricedSoldCount: number
  last7Days: SalesWindow
  last30Days: SalesWindow
  dailyCumulative: { date: string; count: number }[]
  platforms: PlatformSaleRow[]
}

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function daysAgo(date: Date, days: number) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setDate(result.getDate() - days)
  return localDay(result)
}

export function summarizeAcceptedSales(works: AcceptedWork[], now = new Date()): AcceptedSalesSummary {
  const platforms = new Map<string, PlatformSaleRow>()
  const today = localDay(now)
  const days = Array.from({ length: 30 }, (_, index) => daysAgo(now, 29 - index))
  const daily = new Map(days.map((date) => [date, 0]))
  const last7Days = { count: 0, cents: 0 }
  const last30Days = { count: 0, cents: 0 }
  let preliminaryCount = 0, acceptedCount = 0, finalRejectedCount = 0, notAcceptedCount = 0
  let soldCount = 0, buyoutCount = 0, guaranteeShareCount = 0
  let totalCents = 0, realizedShareCents = 0, undatedSoldCount = 0, unpricedSoldCount = 0

  for (const work of works) {
    if (work.review_status === 'not_accepted') { notAcceptedCount++; continue }
    preliminaryCount++
    if (work.review_status === 'preliminary') continue
    if (work.review_status === 'final_rejected') { finalRejectedCount++; continue }
    acceptedCount++
    if (work.deal_mode === 'undecided') continue
    const buyout = work.deal_mode === 'buyout'
    const base = buyout ? work.price_cents : work.guarantee_cents
    if (base <= 0 && !(work.deal_mode === 'guarantee_share' && work.per_thousand_cents > 0)) continue
    if (base <= 0) unpricedSoldCount++
    const share = buyout ? 0 : Math.max(0, work.realized_share_cents || 0)
    const amount = base + share
    soldCount++
    if (buyout) buyoutCount++
    else guaranteeShareCount++
    totalCents += amount
    realizedShareCents += share

    const recordDate = work.accepted_at || ''
    if (!recordDate) undatedSoldCount++
    if (recordDate >= days[0] && recordDate <= today) {
      last30Days.count++
      last30Days.cents += amount
      daily.set(recordDate, (daily.get(recordDate) || 0) + 1)
      if (recordDate >= days[23]) {
        last7Days.count++
        last7Days.cents += amount
      }
    }

    const platform = work.sale_platform.trim() || '未填写平台'
    const key = platform.toLocaleLowerCase()
    const row = platforms.get(key) ?? { platform, count: 0, buyout: 0, guaranteeShare: 0, totalCents: 0 }
    row.count++
    row.totalCents += amount
    if (buyout) row.buyout++
    else row.guaranteeShare++
    platforms.set(key, row)
  }

  let cumulative = 0
  return {
    preliminaryCount, acceptedCount, finalRejectedCount, notAcceptedCount, soldCount, buyoutCount, guaranteeShareCount,
    totalCents, realizedShareCents, undatedSoldCount, unpricedSoldCount, last7Days, last30Days,
    dailyCumulative: days.map((date) => ({ date, count: (cumulative += daily.get(date) || 0) })),
    platforms: [...platforms.values()].sort((a, b) => b.count - a.count || b.totalCents - a.totalCents),
  }
}
