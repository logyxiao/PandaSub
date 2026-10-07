import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { perThousandTotalCents, acceptedGuaranteeCents } = await server.ssrLoadModule('/src/lib/acceptedPricing.ts')
  const { summarizeAcceptedSales } = await server.ssrLoadModule('/src/views/acceptedStats.ts')
  assert.equal(perThousandTotalCents(3000, 10000), 30000)
  assert.equal(perThousandTotalCents(3001, 12345), 37047)
  assert.equal(perThousandTotalCents(1, 500), 1)
  assert.equal(perThousandTotalCents(3000, 0), 0)
  assert.equal(perThousandTotalCents(3000, -1), null)
  assert.equal(perThousandTotalCents(3000, 1.5), null)
  assert.equal(perThousandTotalCents(Number.MAX_SAFE_INTEGER, 1000000), null)
  const base = { review_status:'accepted', deal_mode:'guarantee_share', guarantee_cents:0, per_thousand_cents:3000, word_count:10000, realized_share_cents:5000, share_percent:50, accepted_at:'2026-10-07', sale_platform:'平台', listing_platform:'', monthly_settlements:[] }
  assert.equal(acceptedGuaranteeCents(base), 30000)
  let stats = summarizeAcceptedSales([base],new Date(2026,9,7))
  assert.equal(stats.totalCents,35000)
  assert.equal(stats.last7Days.cents,35000)
  assert.equal(stats.platforms[0].totalCents,35000)
  assert.equal(stats.unpricedSoldCount,0)
  stats=summarizeAcceptedSales([{...base,guarantee_cents:40000}],new Date(2026,9,7))
  assert.equal(stats.totalCents,45000,'explicit total takes precedence, no duplicate unit-price revenue')
  stats=summarizeAcceptedSales([{...base,word_count:0}])
  assert.equal(stats.totalCents,5000);assert.equal(stats.unpricedSoldCount,1)
  assert.equal(summarizeAcceptedSales([{...base,review_status:'preliminary'}]).totalCents,0)
  assert.equal(summarizeAcceptedSales([{...base,deal_mode:'platform_share',monthly_settlements:[{month:'2026-10',amount_cents:9000}]}]).totalCents,9000)
  console.log('PASS: unit-price arithmetic/rounding, manual total precedence, missing count, settled share, summary windows/platforms and unrelated sale modes')
} finally { await server.close() }
