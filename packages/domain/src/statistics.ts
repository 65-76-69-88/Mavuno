import Decimal from 'decimal.js';
import type { AggregateCohort, CohortScope, FxRate, PrivateTransaction, SaleFactKey } from './contracts.js';
import { COFFEE_PROFILE, POLICY_VERSION, REQUIRED_FACTS, cohortDescriptor, cohortId } from './profile.js';
import { assessEligibility, deduplicateTransactions } from './eligibility.js';
import { addDays, daysBetween, normalizeSale, roundForPublication } from './money.js';

// CountBand is an inferred public schema shape, intentionally omitting exact source counts.
type Band = { min: number; max: number };
export function countBand(count: number): Band { const min = Math.floor(count / 5) * 5; return { min, max: min + 4 }; }
export type EvidenceScore = { score: number; completeness: number; corroboration: number; confirmation: number };
export function evidenceScore(record: Pick<PrivateTransaction, 'facts' | 'verification'>): EvidenceScore {
  const required: SaleFactKey[] = [...REQUIRED_FACTS, record.facts.priceBasis.value === 'per_kg' ? 'quotedUnitPrice' : 'cropConsideration'];
  const present = required.filter(field => record.facts[field].value !== null).length;
  const confirmed = required.filter(field => record.facts[field].value !== null &&
    ['confirmed', 'attested'].includes(record.facts[field].status)).length;
  const completeness = present / required.length;
  const confirmation = confirmed / required.length;
  const corroboration = { seller_reported: 0, receipt_attached: 0.25, cooperative_attested: 0.75, independently_audited: 1 }[record.verification];
  return { score: 100 * (0.5 * completeness + 0.3 * corroboration + 0.2 * confirmation), completeness, corroboration, confirmation };
}
/** Credit one final independent review per unique lot, never one credit per review event. */
export function reputationFromReviews(records: PrivateTransaction[], contributorId: string): { score: number; valid: number; invalid: number } {
  let valid = 0; let invalid = 0;
  for (const record of deduplicateTransactions(records).unique.filter(item => item.contributorId === contributorId)) {
    const review = [...record.reviews]
      .filter(event => event.independent && event.reviewerId !== record.contributorId)
      .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt) ||
        Number(b.outcome === 'invalid') - Number(a.outcome === 'invalid') || a.reviewerId.localeCompare(b.reviewerId))[0];
    if (review?.outcome === 'valid') valid += 1;
    if (review?.outcome === 'invalid') invalid += 1;
  }
  return { score: (valid + 2) / (valid + invalid + 4), valid, invalid };
}
export type WeightedPrice = { id: string; contributorId: string; price: string; preliminaryWeight: number; weight: number };
/** Proportional water filling caps total contributor influence, not each individual row. */
export function capContributorWeights(records: Omit<WeightedPrice, 'weight'>[], cap = 0.25): WeightedPrice[] {
  if (!(cap > 0 && cap <= 1)) throw new Error('Contributor cap must lie in (0, 1]');
  const totals = new Map<string, number>();
  for (const record of records) {
    if (!Number.isFinite(record.preliminaryWeight) || record.preliminaryWeight <= 0) throw new Error('Weights must be positive and finite');
    totals.set(record.contributorId, (totals.get(record.contributorId) ?? 0) + record.preliminaryWeight);
  }
  if (totals.size * cap < 1 - 1e-12) throw new Error('Insufficient contributors for cap');
  const shares = new Map<string, number>(); const remaining = new Map(totals);
  let available = 1;
  while (remaining.size) {
    const total = [...remaining.values()].reduce((sum, value) => sum + value, 0);
    const capped = [...remaining.entries()].filter(([, value]) => available * value / total > cap + 1e-12);
    if (capped.length === 0) {
      for (const [id, value] of remaining) shares.set(id, available * value / total);
      break;
    }
    for (const [id] of capped) { shares.set(id, cap); remaining.delete(id); available -= cap; }
  }
  return records.map(record => ({ ...record, weight: shares.get(record.contributorId)! * record.preliminaryWeight / totals.get(record.contributorId)! }));
}
export function weightedQuantile(records: Pick<WeightedPrice, 'price' | 'weight'>[], probability: number): string {
  if (records.length === 0 || probability < 0 || probability > 1) throw new Error('Invalid quantile input');
  if (records.some(record => !Number.isFinite(record.weight) || record.weight < 0)) throw new Error('Invalid quantile weights');
  const sorted = [...records].filter(record => record.weight > 0).sort((a, b) => new Decimal(a.price).cmp(b.price));
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) throw new Error('Quantile needs positive mass');
  let cumulative = 0;
  for (const record of sorted) {
    cumulative += record.weight;
    if (cumulative / total >= probability - 1e-12) return record.price;
  }
  return sorted.at(-1)!.price;
}
export function effectiveSampleSize(weights: number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const squared = weights.reduce((sum, weight) => sum + weight * weight, 0);
  return squared === 0 ? 0 : total * total / squared;
}
function median(prices: string[]): Decimal {
  const sorted = prices.map(value => new Decimal(value)).sort((a, b) => a.cmp(b));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]!.add(sorted[middle]!).div(2);
}
export function flagOutliers(records: Pick<WeightedPrice, 'id' | 'price'>[]): string[] {
  if (records.length === 0) return [];
  const center = median(records.map(record => record.price));
  const mad = median(records.map(record => new Decimal(record.price).sub(center).abs().toFixed()));
  return records.filter(record => mad.eq(0) ? !new Decimal(record.price).eq(center)
    : new Decimal(record.price).sub(center).abs().mul('0.67449').div(mad).gt('3.5')).map(record => record.id);
}
export type CohortDiagnostics = {
  reasons: string[]; lotCount: number; contributorCount: number; cooperativeCount: number;
  transactionEffectiveN: number; contributorEffectiveN: number; maximumContributorWeight: number;
  includedReportIds: string[]; excluded: { id: string; reasons: string[] }[];
  outlierIds: string[]; weights: WeightedPrice[]; unroundedQuantiles: { q25: string; q50: string; q75: string } | null;
  sensitivityMedian: string | null;
};
export function summarizeCohort(records: PrivateTransaction[], scope: CohortScope, asOf: string, rates: FxRate[]): {
  aggregate: AggregateCohort | null; diagnostics: CohortDiagnostics;
} {
  const { unique, duplicates } = deduplicateTransactions(records);
  const excluded: CohortDiagnostics['excluded'] = duplicates.map(record => ({ id: record.id, reasons: ['duplicate_lot_or_report'] }));
  const eligible: PrivateTransaction[] = [];
  const prices: Omit<WeightedPrice, 'weight'>[] = [];
  for (const record of unique) {
    const reasons = assessEligibility(record.facts, scope, asOf, { includeSorting: true }).reasons;
    if (record.reviewState !== 'approved') reasons.push(`review_${record.reviewState}`);
    if (!record.consent.aggregateUse) reasons.push('aggregate_consent_required');
    const normalized = normalizeSale(record.facts, COFFEE_PROFILE.referenceCurrency, rates);
    if (!normalized.ok) reasons.push(...normalized.reasons);
    if (reasons.length || !normalized.ok) { excluded.push({ id: record.id, reasons: [...new Set(reasons)] }); continue; }
    const reputation = reputationFromReviews(unique, record.contributorId).score;
    const age = daysBetween(record.facts.saleDate.value!, asOf);
    const preliminaryWeight = evidenceScore(record).score / 100 * reputation * 2 ** (-age / 30);
    if (preliminaryWeight <= 0) { excluded.push({ id: record.id, reasons: ['zero_evidence_weight'] }); continue; }
    eligible.push(record);
    prices.push({ id: record.id, contributorId: record.contributorId, price: normalized.value.netCropPrice, preliminaryWeight });
  }
  const contributorCount = new Set(eligible.map(record => record.contributorId)).size;
  const cooperativeCount = new Set(eligible.map(record => record.cooperativeId)).size;
  const reasons: string[] = [];
  const policy = COFFEE_PROFILE.publication;
  if (eligible.length < policy.minimumLots) reasons.push('too_few_lots');
  if (contributorCount < policy.minimumContributors) reasons.push('too_few_contributors');
  let weights: WeightedPrice[] = [];
  if (contributorCount >= policy.minimumContributors) weights = capContributorWeights(prices, policy.contributorCap);
  const shares = new Map<string, number>();
  for (const record of weights) shares.set(record.contributorId, (shares.get(record.contributorId) ?? 0) + record.weight);
  const transactionEffectiveN = effectiveSampleSize(weights.map(record => record.weight));
  const contributorEffectiveN = effectiveSampleSize([...shares.values()]);
  const maximumContributorWeight = Math.max(0, ...shares.values());
  if (transactionEffectiveN < policy.minimumTransactionEffectiveN) reasons.push('transaction_concentration');
  if (contributorEffectiveN < policy.minimumContributorEffectiveN) reasons.push('contributor_concentration');
  if (maximumContributorWeight > policy.contributorCap + 1e-10) reasons.push('contributor_cap_exceeded');
  const outlierIds = flagOutliers(prices);
  const unroundedQuantiles = weights.length ? { q25: weightedQuantile(weights, 0.25), q50: weightedQuantile(weights, 0.5), q75: weightedQuantile(weights, 0.75) } : null;
  const withoutOutliers = weights.filter(record => !outlierIds.includes(record.id));
  const sensitivityMedian = withoutOutliers.length ? weightedQuantile(withoutOutliers, 0.5) : null;
  const diagnostics: CohortDiagnostics = { reasons, lotCount: eligible.length, contributorCount, cooperativeCount,
    transactionEffectiveN, contributorEffectiveN, maximumContributorWeight, includedReportIds: eligible.map(record => record.id),
    excluded, outlierIds, weights, unroundedQuantiles, sensitivityMedian };
  if (reasons.length || !unroundedQuantiles) return { aggregate: null, diagnostics };
  const measured = eligible.filter(record => record.facts.moisturePct.value !== null && ['confirmed', 'attested'].includes(record.facts.moisturePct.status)).length;
  const aggregate: AggregateCohort = {
    id: cohortId(scope), scope, descriptor: cohortDescriptor(scope), vector: { byteOffset: 0, dimensions: 384 },
    quantiles: { q25: roundForPublication(unroundedQuantiles.q25), q50: roundForPublication(unroundedQuantiles.q50), q75: roundForPublication(unroundedQuantiles.q75) },
    countBands: { lots: countBand(eligible.length), contributors: countBand(contributorCount), cooperatives: countBand(cooperativeCount) },
    observationWindow: { from: addDays(asOf, -policy.windowDays), to: asOf },
    qualityCoverage: { measuredMoisture: measured === 0 ? 'none' : measured / eligible.length >= 0.8 ? 'broad' : 'partial',
      limitations: ['Reported sorting is not certified grade.', 'Synthetic sales do not establish local market value.', 'Observed prices depend on reporting and shared market conditions.'] },
    publication: { eligible: true, policyVersion: POLICY_VERSION, rounding: policy.rounding }, synthetic: eligible.every(record => record.synthetic),
  };
  return { aggregate, diagnostics };
}
