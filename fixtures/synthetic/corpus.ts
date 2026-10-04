/** Private reproducible training corpus. Hidden factors are generator truth, never browser features. */
import Decimal from 'decimal.js';
import { addDays, emptySaleFacts, fact, type PrivateTransaction, type SaleFactKey, type SaleFacts } from '../../packages/domain/src/index.js';
import { FIXTURE_SEED, SYNTHETIC_CLOCK, transactionToEvidenceRecord } from './generate.js';

export type CorpusSplit = 'train' | 'dev' | 'test';
export type LatentFactors = { s: number; h: number; b: number; t: number };
export type CorpusMetadata = { split: CorpusSplit; family: string; templateFamily: string;
  latentFactors: LatentFactors; observedFactors: (keyof LatentFactors)[]; stressType?: string;
  reviewStatus: 'synthetic_unreviewed'; author: 'implementation-team' };
export const GENERATOR_REVISION = 'evidence-corpus-v2';
export const PRICE_GENERATION_FORMULA = 'log(p)=log(6000)+0.12*s-0.08*h+0.05*b-0.04*t+epsilon; epsilon uniform(-0.035,0.035); p rounded to 50 TZS/kg';
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4_294_967_296; };
}
function set(facts: SaleFacts, key: SaleFactKey, value: string | null): void {
  (facts[key] as { value: unknown; status: string; sourceRefs: string[] }) = fact(value, 'confirmed', ['synthetic:source']);
}
const phrases: Record<CorpusSplit, Record<keyof LatentFactors, string[]>> = {
  train: {
    s: ['Parchment beans remain mixed, with small pieces and visible defects.', 'The family picked out the most obvious broken pieces.', 'Hand sorting removed broken beans and left a uniform clean lot.'],
    h: ['Dried thoroughly and kept dry under a roof.', 'The crop was sheltered but felt slightly damp during storage.', 'Sacks stayed in humid storage and some beans smell musty.'],
    b: ['Loose open sacks were used for transport.', 'Ordinary clean woven sacks hold the beans.', 'Closed lined sacks protect the dried coffee from moisture.'],
    t: ['Easy road access lets the buyer load the lot quickly.', 'Pickup requires a short walk from the road.', 'The lot is far uphill and carrying it to the road takes time.'],
  },
  dev: {
    s: ['Our coffee still contains assorted sizes and damaged pieces.', 'We removed a few conspicuous faults before selling.', 'We selected the beans carefully so the parchment looks evenly clean.'],
    h: ['Storage was airy and the parchment stayed completely dry.', 'A little moisture returned while the coffee waited.', 'A damp storeroom gave the coffee a stale odour.'],
    b: ['The bags are uncovered at their openings.', 'Fresh woven bags were filled for this sale.', 'A moisture-resistant inner layer seals each package.'],
    t: ['A vehicle can stop beside the coffee.', 'A brief carry is needed to reach the pickup point.', 'People must carry the coffee a long distance downhill before collection.'],
  },
  test: {
    s: ['No final selection was done; sizes and blemishes vary.', 'Only easily seen defects were taken away.', 'Careful manual selection produced consistently sound parchment.'],
    h: ['The harvest remained free of moisture in well-ventilated shelter.', 'The stored beans have regained a little humidity.', 'Prolonged wet conditions left an unpleasant smell in the stored beans.'],
    b: ['Packaging has an unclosed top.', 'The consignment uses intact textile bags.', 'Protective liners and tightly closed bags keep the consignment dry.'],
    t: ['The collection truck reaches the storage door.', 'The collection truck stops a small distance away.', 'Access is difficult; the consignment needs a lengthy manual carry.'],
  },
};
function describe(split: CorpusSplit, index: number, factors: LatentFactors, observed: (keyof LatentFactors)[], quantity: number): string {
  const details = observed.map(key => phrases[split][key][factors[key]]!).join(' ');
  const lead: Record<CorpusSplit, string[]> = {
    train: [`I am selling ${quantity} kg of Arabica parchment coffee at the farmgate.`, `This ${quantity} kilogram Arabica parchment lot is ready for a farmgate sale.`, `For sale at our farm: ${quantity} kg, Arabica coffee in parchment form.`],
    dev: [`The harvest offered from the farm is Arabica parchment, weighing ${quantity} kg.`, `We have a farm-level consignment of ${quantity} kg of parchment Arabica.`, `Our ${quantity} kg Arabica crop has been processed to parchment for collection here.`],
    test: [`A buyer is considering ${quantity} kg of parchment from our Arabica harvest at the farm.`, `The available Arabica consignment is in parchment form, ${quantity} kg, sold from the homestead.`, `This sale concerns ${quantity} kilograms of farmgate Arabica parchment.`],
  };
  const ending: Record<CorpusSplit, string> = { train: 'Buyer collects and pays immediately.', dev: 'Collection is by the purchaser, with payment upon collection.', test: 'The purchaser picks up here and settles in cash on the same day.' };
  return `${lead[split][index % 3]} ${details} ${ending[split]}`;
}
export function generateSyntheticCorpus(asOf = SYNTHETIC_CLOCK): { records: PrivateTransaction[]; metadata: Record<string, CorpusMetadata> } {
  const rand = random(FIXTURE_SEED); const records: PrivateTransaction[] = []; const metadata: Record<string, CorpusMetadata> = {};
  const timestamp = `${asOf}T08:00:00.000Z`;
  for (let contributor = 0; contributor < 48; contributor += 1) {
    const split: CorpusSplit = contributor < 32 ? 'train' : contributor < 40 ? 'dev' : 'test';
    for (let lot = 0; lot < 3; lot += 1) {
      const index = records.length; const id = `corpus-${String(index + 1).padStart(3, '0')}`;
      const factors: LatentFactors = { s: Math.floor(rand() * 3), h: Math.floor(rand() * 3), b: Math.floor(rand() * 3), t: Math.floor(rand() * 3) };
      const observed = (['s', 'h', 'b', 't'] as const).filter((_, factor) => (index + factor) % 11 !== 0);
      const quantity = 20 + Math.floor(rand() * 181);
      const noise = (rand() - 0.5) * 0.07;
      const price = Math.round(Math.exp(Math.log(6000) + 0.12 * factors.s - 0.08 * factors.h + 0.05 * factors.b - 0.04 * factors.t + noise) / 50) * 50;
      const costs = index % 3 === 0 ? 2500 : 0; const conversion = index % 9 === 0 ? new Decimal(2500) : new Decimal(1);
      const currency = index % 9 === 0 ? 'USD' : 'TZS'; const facts = emptySaleFacts();
      const values = { cropId: 'coffee', species: 'arabica', productForm: 'parchment', marketAreaId: 'ondera-demo',
        saleChannel: 'farmgate', deliveryTerms: 'buyer_collects', paymentTerms: 'immediate', currency, priceBasis: 'lot',
        sourceQuantity: String(quantity), sourceUnit: 'kg', quantityKg: String(quantity), saleDate: addDays('2026-09-01', index % 30),
        cropConsideration: new Decimal(price).mul(quantity).add(costs).div(conversion).toFixed(),
        saleCosts: new Decimal(costs).div(conversion).toFixed(), loanSettlement: '0' };
      for (const [key, value] of Object.entries(values)) set(facts, key as SaleFactKey, value);
      const narrative = describe(split, contributor + lot, factors, observed, quantity);
      const record: PrivateTransaction = { id, clientReportId: `report-${id}`, lotId: `lot-${id}`,
        contributorId: `fictional-contributor-${String(contributor + 1).padStart(2, '0')}`, cooperativeId: `fictional-cooperative-${contributor % 3 + 1}`,
        facts, originalText: `${narrative} Crop consideration ${currency} ${facts.cropConsideration.value}; charges ${currency} ${facts.saleCosts.value}.`,
        inputLanguage: 'en', evidenceRefs: [], consent: { upload: true, aggregateUse: true, recordedAt: timestamp },
        reviewState: 'approved', verification: contributor % 4 === 0 ? 'receipt_attached' : 'cooperative_attested',
        reviews: [{ reviewerId: 'fictional-independent-reviewer', outcome: 'valid', reviewedAt: timestamp, independent: contributor % 8 !== 0 }], synthetic: true };
      records.push(record); metadata[id] = { split, family: `${split}-scenario-${contributor}`, templateFamily: `${split}-narrative-${(contributor + lot) % 3}`,
        latentFactors: factors, observedFactors: [...observed], reviewStatus: 'synthetic_unreviewed', author: 'implementation-team' };
    }
  }
  const stress = (source: number, type: string, modify: (record: PrivateTransaction) => void) => {
    const record = structuredClone(records[source]!); const id = `corpus-${String(records.length + 1).padStart(3, '0')}`;
    record.id = id; record.clientReportId = `report-${id}`; record.lotId = `lot-${id}`;
    modify(record);
    // Rebuild receipt-like arithmetic from the modified source facts. A valid extreme must not
    // carry a stale source receipt that contradicts its new consideration or financing settlement.
    const sourceDescription = record.originalText.replace(/\s*Crop consideration[\s\S]*$/i, '');
    const currency = record.facts.currency.value ?? 'unknown currency';
    const priceLabel = record.facts.priceBasis.value === 'per_kg' ? 'Unit quote' : 'Crop consideration';
    const amount = record.facts.priceBasis.value === 'per_kg' ? record.facts.quotedUnitPrice.value : record.facts.cropConsideration.value;
    record.originalText = `${sourceDescription} ${priceLabel} ${currency} ${amount ?? 'unknown'}${record.facts.priceBasis.value === 'per_kg' ? '/kg' : ''}; charges ${currency} ${record.facts.saleCosts.value ?? 'unknown'}.`;
    if (record.facts.loanSettlement.value !== null && record.facts.loanSettlement.value !== '0') record.originalText += ` Loan ${currency} ${record.facts.loanSettlement.value}.`;
    if ((type === 'loan_settlement' || type === 'quantity_near_80') && record.facts.quantityKg.value)
      record.originalText = record.originalText.replace(/\b\d+\s*(?:kilograms?|kg)\b/gi, `${record.facts.quantityKg.value} kg`);
    records.push(record); metadata[id] = { ...structuredClone(metadata[records[source]!.id]!), stressType: type };
  };
  for (let i = 0; i < 8; i += 1) stress(i * 3, 'processing_state', record => {
    set(record.facts, 'productForm', i < 4 ? 'cherry' : 'green'); record.originalText = record.originalText.replace(/parchment/gi, i < 4 ? 'unprocessed coffee cherries' : 'hulled green beans');
  });
  for (let i = 0; i < 4; i += 1) stress(24 + i * 3, 'different_terms', record => {
    set(record.facts, i < 2 ? 'paymentTerms' : 'deliveryTerms', i < 2 ? 'deferred' : 'seller_delivers');
    record.originalText = record.originalText.replace('Buyer collects and pays immediately.', i < 2 ? 'Buyer collects but pays thirty days later.' : 'Seller delivers to a warehouse; buyer pays immediately.');
  });
  for (let i = 0; i < 4; i += 1) stress(36 + i * 3, 'foreign_market', record => {
    set(record.facts, 'marketAreaId', i < 2 ? 'india-example' : 'kenya-example'); set(record.facts, 'currency', i < 2 ? 'INR' : 'KES');
    set(record.facts, 'priceBasis', 'per_kg'); set(record.facts, 'quotedUnitPrice', i < 2 ? '100' : '162.5'); set(record.facts, 'saleCosts', '0');
  });
  for (let i = 0; i < 4; i += 1) stress(48 + i * 3, 'stale_sale', record => set(record.facts, 'saleDate', addDays(asOf, -100 - i)));
  for (let i = 0; i < 4; i += 1) stress(i * 3, 'duplicate_lot', record => { record.lotId = records[i * 3]!.lotId; });
  for (let i = 0; i < 4; i += 1) stress(60 + i * 3, 'critical_missing_or_conflicting', record => {
    if (i === 0) set(record.facts, 'quantityKg', null);
    if (i === 1) set(record.facts, 'saleCosts', null);
    if (i === 2) { set(record.facts, 'sourceQuantity', '500'); set(record.facts, 'quantityKg', '50'); }
    if (i === 3) set(record.facts, 'marketAreaId', null);
    record.reviewState = 'rejected'; record.reviews = [{ reviewerId: 'fictional-independent-reviewer', outcome: 'invalid', reviewedAt: timestamp, independent: true }];
  });
  stress(73, 'valid_low_price', record => { set(record.facts, 'currency', 'TZS'); set(record.facts, 'cropConsideration', new Decimal(record.facts.quantityKg.value!).mul(1500).toFixed()); set(record.facts, 'saleCosts', '0'); });
  stress(76, 'valid_high_price', record => { set(record.facts, 'currency', 'TZS'); set(record.facts, 'cropConsideration', new Decimal(record.facts.quantityKg.value!).mul(14000).toFixed()); set(record.facts, 'saleCosts', '0'); });
  stress(79, 'loan_settlement', record => { set(record.facts, 'currency', 'TZS'); set(record.facts, 'sourceQuantity', '50'); set(record.facts, 'quantityKg', '50'); set(record.facts, 'cropConsideration', '300000'); set(record.facts, 'saleCosts', '0'); set(record.facts, 'loanSettlement', '60000'); });
  stress(82, 'quantity_near_80', record => { set(record.facts, 'currency', 'TZS'); set(record.facts, 'sourceQuantity', '80'); set(record.facts, 'quantityKg', '80'); set(record.facts, 'cropConsideration', '480000'); set(record.facts, 'saleCosts', '0'); });
  return { records, metadata };
}
export function generateSyntheticEvidenceCorpus(asOf = SYNTHETIC_CLOCK) {
  const corpus = generateSyntheticCorpus(asOf);
  return { records: corpus.records.map(transactionToEvidenceRecord), metadata: corpus.metadata };
}
/** These labels support a synthetic training experiment, never independent comparability validation. */
export function syntheticRelation(a: CorpusMetadata, b: CorpusMetadata): 'comparable' | 'non_comparable' | 'unknown' {
  if (a.stressType || b.stressType || a.observedFactors.length < 3 || b.observedFactors.length < 3) return 'unknown';
  const differences = (['s', 'h', 'b', 't'] as const).map(key => Math.abs(a.latentFactors[key] - b.latentFactors[key]));
  const total = differences.reduce((sum, value) => sum + value, 0);
  return total <= 2 && differences[0]! < 2 && differences[1]! < 2 ? 'comparable'
    : differences[0] === 2 || differences[1] === 2 || total >= 5 ? 'non_comparable' : 'unknown';
}
