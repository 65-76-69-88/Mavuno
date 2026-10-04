import Decimal from 'decimal.js';
import type { CohortScope, LotBand, PrivateTransaction, SaleFacts } from './contracts.js';
import { COFFEE_PROFILE, REQUIRED_FACTS } from './profile.js';
import { daysBetween } from './money.js';

export function lotBandForQuantity(quantityKg: string): LotBand | null {
  const quantity = new Decimal(quantityKg);
  if (quantity.gte(20) && quantity.lt(80)) return 'small';
  if (quantity.gte(80) && quantity.lte(200)) return 'medium';
  return null;
}
export type EligibilityResult = { eligible: boolean; reasons: string[]; lotBand: LotBand | null };
export function assessEligibility(facts: SaleFacts, scope: CohortScope, asOf: string, options: { includeSorting?: boolean; requireConfirmation?: boolean } = {}): EligibilityResult {
  const reasons: string[] = [];
  const requireConfirmation = options.requireConfirmation ?? true;
  for (const field of REQUIRED_FACTS) {
    const value = facts[field];
    if (value.value === null) reasons.push(`missing_${field}`);
    else if (requireConfirmation && value.status !== 'confirmed' && value.status !== 'attested') reasons.push(`unconfirmed_${field}`);
  }
  for (const field of ['cropId', 'species', 'productForm', 'marketAreaId', 'saleChannel', 'deliveryTerms', 'paymentTerms'] as const) {
    if (facts[field].value !== null && facts[field].value !== scope[field]) reasons.push(`incompatible_${field}`);
  }
  let lotBand: LotBand | null = null;
  try {
    if (facts.quantityKg.value !== null) {
      lotBand = lotBandForQuantity(facts.quantityKg.value);
      if (lotBand === null) reasons.push('unsupported_lot_size');
      else if (lotBand !== scope.lotBand) reasons.push('incompatible_lotBand');
    }
    if (facts.saleDate.value !== null) {
      const age = daysBetween(facts.saleDate.value, asOf);
      if (age < 0) reasons.push('future_sale');
      else if (age > COFFEE_PROFILE.publication.windowDays) reasons.push('stale_sale');
    }
  } catch { reasons.push('invalid_quantity_or_date'); }
  if (options.includeSorting) {
    if (facts.sorting.value === null) reasons.push('missing_sorting');
    else if (facts.sorting.value !== scope.sorting) reasons.push('incompatible_sorting');
    else if (requireConfirmation && facts.sorting.status !== 'confirmed' && facts.sorting.status !== 'attested') reasons.push('unconfirmed_sorting');
  }
  return { eligible: reasons.length === 0, reasons, lotBand };
}
/** Use the earliest received copy: duplicates cannot replace or add to an existing lot. */
export function deduplicateTransactions(records: PrivateTransaction[]): { unique: PrivateTransaction[]; duplicates: PrivateTransaction[] } {
  const lots = new Set<string>(); const reports = new Set<string>();
  const unique: PrivateTransaction[] = []; const duplicates: PrivateTransaction[] = [];
  for (const record of records) {
    if (lots.has(record.lotId) || reports.has(record.clientReportId)) duplicates.push(record);
    else { unique.push(record); lots.add(record.lotId); reports.add(record.clientReportId); }
  }
  return { unique, duplicates };
}
export function isPackExpired(validUntil: string, today: string): boolean { return daysBetween(validUntil, today) > 0; }
