/** SERVER/TRAINING ONLY. Do not import this module into the browser application. */
import Decimal from 'decimal.js';
import { COHORT_SCOPES, addDays, cohortDescriptor, confirmFacts, emptySaleFacts, fact, moneyBasisFromFacts,
  observationsFromDescription, preprocessDescription, type EvidenceRecord, type FxRate, type PrivateTransaction,
  type SaleFacts, type SaleFactKey } from '../../packages/domain/src/index.js';

export const SYNTHETIC_CLOCK = '2026-10-04';
export const FIXTURE_SEED = 20261004;
export const SYNTHETIC_FX: FxRate[] = Array.from({ length: 40 }, (_, index) => ({
  date: addDays('2026-08-29', index), baseCurrency: 'USD',
  rates: { USD: '1', TZS: '2500', INR: '80', KES: '130', EUR: '0.9' },
  quoteDirection: 'currency_per_base', provider: 'Team-generated arithmetic fixture',
  license: 'CC0-1.0', synthetic: true,
}));
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4_294_967_296; };
}
function set(facts: SaleFacts, key: SaleFactKey, value: string | null): void {
  (facts[key] as { value: unknown; status: string; sourceRefs: string[] }) = fact(value, 'confirmed', ['synthetic:source']);
}
/** Exactly 64 ordinary lots + 32 specified challenges. Prices are invented, never calibrated local values. */
export function generateSyntheticTransactions(asOf = SYNTHETIC_CLOCK): PrivateTransaction[] {
  const rand = random(FIXTURE_SEED); const records: PrivateTransaction[] = [];
  const timestamp = `${asOf}T08:00:00.000Z`;
  for (let group = 0; group < COHORT_SCOPES.length; group += 1) {
    const scope = COHORT_SCOPES[group]!;
    for (let index = 0; index < 16; index += 1) {
      const id = `synthetic-${String(records.length + 1).padStart(3, '0')}`;
      const contributor = `fictional-contributor-${group}-${index % 8}`;
      const quantity = scope.lotBand === 'small' ? 25 + Math.floor(rand() * 50) : 80 + Math.floor(rand() * 121);
      const price = (scope.sorting === 'sorted' ? 6000 : 5200) + (scope.lotBand === 'medium' ? 200 : 0) + (index % 7 - 3) * 100;
      const costs = index % 3 === 0 ? 2500 : 0;
      const usd = index % 7 === 0;
      const sourceCurrency = usd ? 'USD' : 'TZS'; const conversion = usd ? new Decimal(2500) : new Decimal(1);
      const facts = emptySaleFacts();
      for (const [key, value] of Object.entries(scope)) if (key !== 'lotBand') set(facts, key as SaleFactKey, value);
      set(facts, 'sourceQuantity', String(quantity)); set(facts, 'sourceUnit', 'kg'); set(facts, 'quantityKg', String(quantity));
      set(facts, 'saleDate', addDays(asOf, -4 - index % 30)); set(facts, 'currency', sourceCurrency); set(facts, 'priceBasis', 'lot');
      set(facts, 'cropConsideration', new Decimal(price).mul(quantity).add(costs).div(conversion).toFixed());
      set(facts, 'saleCosts', new Decimal(costs).div(conversion).toFixed()); set(facts, 'loanSettlement', '0');
      if (index % 3) set(facts, 'moisturePct', String(10 + index % 4));
      const storage = index % 2 ? 'Stored in clean dry sacks, sheltered from rain.' : 'Dried on raised mats and stored briefly in a ventilated room.';
      const originalText = `${cohortDescriptor(scope)} ${storage} ${quantity} kg. Crop consideration ${sourceCurrency} ${facts.cropConsideration.value}; charges ${sourceCurrency} ${facts.saleCosts.value}.`;
      records.push({ id, clientReportId: `report-${id}`, lotId: `lot-${id}`, contributorId: contributor,
        cooperativeId: `fictional-cooperative-${index % 3 + 1}`, facts: confirmFacts(facts), originalText,
        inputLanguage: 'en', evidenceRefs: [], consent: { upload: true, aggregateUse: true, recordedAt: timestamp },
        reviewState: 'approved', verification: index % 4 === 0 ? 'receipt_attached' : 'cooperative_attested',
        reviews: [{ reviewerId: 'fictional-independent-reviewer', outcome: 'valid', reviewedAt: timestamp, independent: index % 8 !== 0 }], synthetic: true });
    }
  }
  const challenge = (source: number, modify: (record: PrivateTransaction) => void) => {
    const record = structuredClone(records[source]!); const id = `synthetic-${String(records.length + 1).padStart(3, '0')}`;
    record.id = id; record.clientReportId = `report-${id}`; record.lotId = `lot-${id}`;
    record.originalText = `${record.originalText} Synthetic challenge case.`;
    modify(record); records.push(record);
  };
  for (let index = 0; index < 8; index += 1) challenge(index, record => {
    set(record.facts, 'productForm', index < 4 ? 'cherry' : 'green');
    record.originalText = record.originalText.replace(/parchment/gi, index < 4 ? 'cherry' : 'green coffee');
  });
  for (let index = 0; index < 4; index += 1) challenge(index + 8, record => {
    set(record.facts, index < 2 ? 'paymentTerms' : 'deliveryTerms', index < 2 ? 'deferred' : 'seller_delivers');
    record.originalText += index < 2 ? ' Payment is deferred for thirty days.' : ' Seller delivers to buyer warehouse.';
  });
  for (let index = 0; index < 4; index += 1) challenge(index + 16, record => {
    set(record.facts, 'marketAreaId', index < 2 ? 'india-example' : 'kenya-example');
    set(record.facts, 'currency', index < 2 ? 'INR' : 'KES'); set(record.facts, 'priceBasis', 'per_kg');
    set(record.facts, 'quotedUnitPrice', index < 2 ? '100' : '162.5'); set(record.facts, 'saleCosts', '0');
  });
  for (let index = 0; index < 4; index += 1) challenge(index + 20, record => set(record.facts, 'saleDate', addDays(asOf, -100 - index)));
  for (let index = 0; index < 4; index += 1) challenge(index, record => { record.lotId = records[index]!.lotId; });
  for (let index = 0; index < 4; index += 1) challenge(index + 24, record => {
    if (index === 0) set(record.facts, 'quantityKg', null);
    if (index === 1) set(record.facts, 'saleCosts', null);
    if (index === 2) { set(record.facts, 'sourceQuantity', '500'); set(record.facts, 'quantityKg', '50'); }
    if (index === 3) { set(record.facts, 'productForm', null); record.originalText += ' Not parchment, or perhaps green coffee; uncertain.'; }
    record.reviewState = 'rejected'; record.reviews = [{ reviewerId: 'fictional-independent-reviewer', outcome: 'invalid', reviewedAt: timestamp, independent: true }];
  });
  challenge(1, record => { set(record.facts, 'cropConsideration', new Decimal(record.facts.quantityKg.value!).mul(1500).toFixed()); set(record.facts, 'saleCosts', '0'); });
  challenge(2, record => { set(record.facts, 'cropConsideration', new Decimal(record.facts.quantityKg.value!).mul(14000).toFixed()); set(record.facts, 'saleCosts', '0'); });
  challenge(3, record => { set(record.facts, 'sourceQuantity', '50'); set(record.facts, 'quantityKg', '50'); set(record.facts, 'cropConsideration', '300000'); set(record.facts, 'saleCosts', '0'); set(record.facts, 'loanSettlement', '60000'); });
  challenge(4, record => { set(record.facts, 'sourceQuantity', '80'); set(record.facts, 'quantityKg', '80'); set(record.facts, 'cropConsideration', '496000'); set(record.facts, 'saleCosts', '0'); });
  return records;
}
export function transactionToEvidenceRecord(record: PrivateTransaction): EvidenceRecord {
  const prepared = preprocessDescription(record.originalText);
  const money = moneyBasisFromFacts(record.facts);
  return { id: record.id, clientReportId: record.clientReportId, lotId: record.lotId, contributorId: record.contributorId,
    custodianId: record.cooperativeId, rawText: record.originalText, language: record.inputLanguage,
    attachmentRefs: record.evidenceRefs, observations: observationsFromDescription(prepared.description),
    ...(money ? { money } : {}), context: { cropId: record.facts.cropId.value ?? undefined,
      marketAreaId: record.facts.marketAreaId.value ?? undefined, date: record.facts.saleDate.value ?? undefined,
      marketTier: record.facts.saleChannel.value === 'farmgate' ? 'farmgate' : undefined,
      status: 'confirmed', sourceRefs: ['synthetic:selected-context'] }, descriptionText: prepared.description,
    consent: record.consent, reviewState: record.reviewState, synthetic: true, verification: record.verification, reviews: record.reviews };
}
export function generateSyntheticEvidenceRecords(asOf = SYNTHETIC_CLOCK): EvidenceRecord[] {
  return generateSyntheticTransactions(asOf).map(transactionToEvidenceRecord);
}
