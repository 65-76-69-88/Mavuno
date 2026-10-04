import Decimal from 'decimal.js';
import { emptySaleFacts, fact, type FxRate, type PrivateTransaction } from './contracts.js';
import type { EvidenceRecord } from './learned-contracts.js';
import { daysBetween, normalizeMoneyBasis } from './money.js';
import type { EvidenceScore } from './statistics.js';

export function evidenceRecordScore(record: EvidenceRecord): EvidenceScore {
  const money = record.money;
  const fields: { present: boolean; confirmed: boolean }[] = [];
  const moneyConfirmed = money?.status === 'confirmed';
  for (const value of [money?.amount, money?.currency, money?.basis, money?.cropCharges]) fields.push({ present: value !== undefined, confirmed: value !== undefined && moneyConfirmed });
  if (money?.basis === 'lot' || (money?.cropCharges !== undefined && new Decimal(money.cropCharges).gt(0)))
    fields.push({ present: money.quantityKg !== undefined, confirmed: money.quantityKg !== undefined && moneyConfirmed });
  const contextConfirmed = record.context.status === 'confirmed';
  for (const value of [record.context.cropId, record.context.marketAreaId, record.context.date, record.context.marketTier])
    fields.push({ present: value !== undefined, confirmed: value !== undefined && contextConfirmed });
  const completeness = fields.filter(field => field.present).length / fields.length;
  const confirmation = fields.filter(field => field.confirmed).length / fields.length;
  const corroboration = { seller_reported: 0, receipt_attached: 0.25, cooperative_attested: 0.75, independently_audited: 1 }[record.verification ?? 'seller_reported'];
  return { score: 100 * (0.5 * completeness + 0.3 * corroboration + 0.2 * confirmation), completeness, confirmation, corroboration };
}
export function assessEvidenceRecordEligibility(record: EvidenceRecord, scope: { cropId: string; regionId: string; marketTier: string; referenceCurrency: string }, asOf: string, rates: FxRate[]): { eligible: boolean; reasons: string[]; netCropPrice: string | null } {
  const reasons: string[] = [];
  if (record.reviewState !== 'approved') reasons.push(`review_${record.reviewState}`);
  if (!record.consent.aggregateUse) reasons.push('aggregate_consent_required');
  if (!record.context.cropId || !record.context.marketAreaId || !record.context.marketTier || !record.context.date) reasons.push('missing_context');
  if (record.context.cropId && record.context.cropId !== scope.cropId) reasons.push('incompatible_crop');
  if (record.context.marketAreaId && record.context.marketAreaId !== scope.regionId) reasons.push('incompatible_market');
  if (record.context.marketTier && record.context.marketTier !== scope.marketTier) reasons.push('incompatible_market_tier');
  if (record.context.status !== 'confirmed') reasons.push('unconfirmed_context');
  if (record.context.date) {
    try { const age = daysBetween(record.context.date, asOf); if (age < 0) reasons.push('future_sale'); if (age > 90) reasons.push('stale_sale'); }
    catch { reasons.push('invalid_date'); }
  }
  if (!record.descriptionText.trim()) reasons.push('description_missing');
  const normalized = record.money && record.context.date ? normalizeMoneyBasis(record.money, record.context.date, scope.referenceCurrency, rates) : null;
  if (!normalized) reasons.push('missing_money_or_date');
  else if (!normalized.ok) reasons.push(...normalized.reasons);
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], netCropPrice: normalized?.ok ? normalized.value.netCropPrice : null };
}
/** Compatibility bridge for custodian storage; no optional quality value is fabricated. */
export function evidenceRecordToTransaction(record: EvidenceRecord): PrivateTransaction & { evidenceRecord: EvidenceRecord } {
  const facts = emptySaleFacts(); const money = record.money;
  const status = money?.status === 'confirmed' ? 'confirmed' : 'extracted';
  facts.cropId = fact(record.context.cropId ?? null, record.context.status === 'confirmed' ? 'confirmed' : 'reported', record.context.sourceRefs ?? []);
  facts.marketAreaId = fact(record.context.marketAreaId ?? null, record.context.status === 'confirmed' ? 'confirmed' : 'reported', record.context.sourceRefs ?? []);
  facts.saleDate = fact(record.context.date ?? null, record.context.status === 'confirmed' ? 'confirmed' : 'reported', record.context.sourceRefs ?? []);
  facts.saleChannel = fact(record.context.marketTier ?? null, record.context.status === 'confirmed' ? 'confirmed' : 'reported', record.context.sourceRefs ?? []);
  if (money) {
    facts.currency = fact(money.currency, status, money.sourceRefs); facts.priceBasis = fact(money.basis, status, money.sourceRefs);
    facts.quantityKg = fact(money.quantityKg ?? null, status, money.sourceRefs); facts.sourceQuantity = fact(money.sourceQuantity ?? null, status, money.sourceRefs);
    facts.sourceUnit = fact(money.sourceUnit ?? null, status, money.sourceRefs); facts.saleCosts = fact(money.cropCharges ?? null, status, money.sourceRefs);
    facts.loanSettlement = fact(money.loanSettlement ?? null, status, money.sourceRefs);
    if (money.basis === 'per_kg') facts.quotedUnitPrice = fact(money.amount, status, money.sourceRefs);
    else facts.cropConsideration = fact(money.amount, status, money.sourceRefs);
  }
  return { id: record.id, clientReportId: record.clientReportId, lotId: record.lotId, contributorId: record.contributorId,
    cooperativeId: record.custodianId, facts, originalText: record.rawText, inputLanguage: record.language,
    evidenceRefs: record.attachmentRefs, consent: record.consent, reviewState: record.reviewState,
    verification: record.verification ?? 'seller_reported', reviews: record.reviews ?? [], synthetic: record.synthetic, evidenceRecord: record };
}
