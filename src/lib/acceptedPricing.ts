import type { AcceptedWorkSummary } from '../types'

/** Yuan per 1000 characters, stored as cents. Round half-up once to whole cents. */
export function perThousandTotalCents(rateCents: number, words: number): number | null {
  if (!Number.isSafeInteger(rateCents) || rateCents < 0 || !Number.isSafeInteger(words) || words < 0) return null
  const total = (BigInt(rateCents) * BigInt(words) + 500n) / 1000n
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null
}

export function acceptedGuaranteeCents(work: Pick<AcceptedWorkSummary, 'guarantee_cents' | 'per_thousand_cents' | 'word_count'>) {
  // An explicitly recorded contract total always takes precedence over the unit rate.
  return work.guarantee_cents > 0 ? work.guarantee_cents : perThousandTotalCents(work.per_thousand_cents || 0, work.word_count || 0) ?? 0
}
