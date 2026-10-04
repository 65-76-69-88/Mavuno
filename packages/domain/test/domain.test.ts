import { describe, expect, it } from 'vitest';
import { COHORT_SCOPES, applyAdapter, capContributorWeights, confirmFacts, convertCurrency, decodePrototype, deduplicateTransactions,
  comparePrivateReference, emptySaleFacts, evidenceRecordScore, evidenceRecordToTransaction, fact, mixtureCdf, mixtureQuantile, moneyBasisFromFacts, normalizeMoneyBasis,
  normalizeSale, offerDeltaPct, parseExactFacts, preprocessDescription, reputationFromReviews, summarizeCohort, weightedQuantile,
  type EvidenceRecord, type FxRate, type MoneyBasis } from '../src/index.js';
import { generateSyntheticTransactions, SYNTHETIC_FX } from '../../../fixtures/synthetic/generate.js';
import { generateSyntheticCorpus } from '../../../fixtures/synthetic/corpus.js';

const rate: FxRate = { date: '2026-09-30', baseCurrency: 'USD', rates: { USD: '1', INR: '80', KES: '130', TZS: '2500' },
  quoteDirection: 'currency_per_base', provider: 'synthetic', license: 'CC0-1.0', synthetic: true };
const money: MoneyBasis = { amount: '300000', currency: 'TZS', basis: 'lot', quantityKg: '50', cropCharges: '0',
  loanSettlement: '60000', status: 'confirmed', sourceRefs: ['synthetic:receipt'] };
describe('crop price arithmetic and dated common-base FX', () => {
  it('keeps financing separate from crop consideration', () => {
    const result = normalizeMoneyBasis(money, '2026-10-04', 'TZS', []);
    expect(result).toMatchObject({ ok: true, value: { netCropPrice: '6000', settlementCash: '240000', cropConsideration: '300000' } });
    expect(normalizeMoneyBasis({ ...money, loanSettlement: '0' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000', settlementCash: '300000' } });
  });
  it('does not divide a per-kg quote by lot weight, and supports a weightless per-kg quote', () => {
    expect(normalizeMoneyBasis({ ...money, amount: '6000', basis: 'per_kg' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000' } });
    expect(normalizeMoneyBasis({ amount: '6000', currency: 'TZS', basis: 'per_kg', cropCharges: '0', status: 'confirmed', sourceRefs: [] }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000', settlementCash: null } });
  });
  it('requires charge knowledge and reliable quantities for allocation', () => {
    expect(normalizeMoneyBasis({ ...money, cropCharges: undefined }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: false, reasons: ['unknown_crop_charges'] });
    expect(normalizeMoneyBasis({ ...money, quantityKg: undefined }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: false, reasons: ['quantity_required'] });
    expect(normalizeMoneyBasis({ ...money, quantityKg: '0' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: false, reasons: ['invalid_quantity'] });
    expect(normalizeMoneyBasis({ ...money, sourceQuantity: '2', sourceUnit: 'kg' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: false, reasons: ['quantity_unit_conflict'] });
  });
  it('checks supplied source units without demanding a quantity for a zero-charge per-kg quote', () => {
    const quote: MoneyBasis = { amount: '6000', currency: 'TZS', basis: 'per_kg', cropCharges: '0', status: 'confirmed', sourceRefs: [] };
    expect(normalizeMoneyBasis(quote, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000' } });
    expect(normalizeMoneyBasis({ ...quote, sourceQuantity: '0.05', sourceUnit: 'tonne', quantityKg: '50' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000' } });
    expect(normalizeMoneyBasis({ ...quote, sourceQuantity: '100', sourceUnit: 'lb', quantityKg: '45.359237' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000' } });
    expect(normalizeMoneyBasis({ ...quote, sourceQuantity: '0.05', sourceUnit: 'tonne', quantityKg: '49' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: false, reasons: ['quantity_unit_conflict'] });
    expect(normalizeMoneyBasis({ ...quote, sourceQuantity: '2', sourceUnit: 'unknown_unit', quantityKg: '50' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: false, reasons: ['unsupported_unit'] });
    expect(normalizeMoneyBasis({ ...quote, sourceQuantity: '-2', sourceUnit: 'sack' }, '2026-10-04', 'TZS', [])).toMatchObject({ ok: false, reasons: ['invalid_source_quantity'] });
  });
  it('uses reference date before sale and no FX default for missing or stale pairs', () => {
    expect(convertCurrency('100', 'INR', 'KES', '2026-10-04', [rate])).toMatchObject({ ok: true, amount: '162.5' });
    expect(convertCurrency('100', 'INR', 'KES', '2026-09-29', [rate])).toMatchObject({ ok: false, reasons: ['missing_fx_pair'] });
    expect(convertCurrency('100', 'INR', 'KES', '2026-10-08', [rate])).toMatchObject({ ok: false, reasons: ['stale_fx_rate'] });
    expect(convertCurrency('100', 'GBP', 'TZS', '2026-10-04', [rate])).toMatchObject({ ok: false, reasons: ['missing_fx_pair'] });
    expect(convertCurrency('100', 'TZS', 'TZS', '2026-10-04', [])).toMatchObject({ ok: true, amount: '100', fixing: null });
    expect(offerDeltaPct('4800', '6000')).toBe('-20');
  });
  it('does not promote an extracted loan to confirmed settlement cash', () => {
    const parsed = parseExactFacts('50 kg coffee. Offer TZS 300000. Charges TZS 0. Loan repayment TZS 60000.');
    const facts = confirmFacts(parsed.facts, ['priceBasis', 'currency', 'cropConsideration', 'quantityKg', 'saleCosts']);
    const basis = moneyBasisFromFacts(facts)!;
    expect(basis.status).toBe('confirmed'); expect(basis.loanSettlement).toBeUndefined();
    expect(normalizeMoneyBasis(basis, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000', settlementCash: null } });
    const loanConfirmed = moneyBasisFromFacts(confirmFacts(facts, ['loanSettlement']))!;
    expect(normalizeMoneyBasis(loanConfirmed, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000', settlementCash: '240000' } });
  });
  it('keeps optional unconfirmed weight out of a confirmed zero-charge unit quote', () => {
    const parsed = parseExactFacts('50 kg coffee. Offer TZS 6000/kg. No charges. Loan repayment TZS 60000.');
    const facts = confirmFacts(parsed.facts, ['priceBasis', 'currency', 'quotedUnitPrice', 'saleCosts', 'loanSettlement']);
    const basis = moneyBasisFromFacts(facts)!;
    expect(basis.status).toBe('confirmed');
    expect(basis.quantityKg).toBeUndefined(); expect(basis.sourceQuantity).toBeUndefined(); expect(basis.sourceUnit).toBeUndefined();
    expect(normalizeMoneyBasis(basis, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000', cropConsideration: null, settlementCash: null } });
    const quantityConfirmed = moneyBasisFromFacts(confirmFacts(facts, ['quantityKg']))!;
    expect(normalizeMoneyBasis(quantityConfirmed, '2026-10-04', 'TZS', [])).toMatchObject({ ok: true, value: { netCropPrice: '6000', cropConsideration: '300000', settlementCash: '240000' } });
  });
});

describe('record influence and publication diagnostics', () => {
  it('water fills contributor shares and preserves within-contributor evidence ratios', () => {
    const input = [ { id: 'a1', contributorId: 'a', price: '100', preliminaryWeight: 100 },
      { id: 'a2', contributorId: 'a', price: '100', preliminaryWeight: 50 },
      ...['b', 'c', 'd', 'e'].map(id => ({ id, contributorId: id, price: '100', preliminaryWeight: 1 })) ];
    const result = capContributorWeights(input);
    const a = result.filter(row => row.contributorId === 'a');
    expect(a.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(0.25, 12);
    expect(a[0]!.weight / a[1]!.weight).toBeCloseTo(2, 12);
    expect(result.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(1, 12);
    expect(result.find(row => row.id === 'b')!.weight).toBeCloseTo(0.1875, 12);
  });
  it('uses inverse weighted CDF with ties', () => {
    const values = [{ price: '100', weight: 0.25 }, { price: '200', weight: 0.25 }, { price: '200', weight: 0.25 }, { price: '400', weight: 0.25 }];
    expect(weightedQuantile(values, 0.25)).toBe('100');
    expect(weightedQuantile(values, 0.5)).toBe('200');
    expect(weightedQuantile(values, 0.75)).toBe('200');
  });
  it('gives no duplicate reputation credit and no upload credit', () => {
    const records = generateSyntheticTransactions(); const reviewed = records[1]!;
    const copy = { ...structuredClone(reviewed), id: 'copy', clientReportId: 'copy-report' };
    const unreviewed = { ...structuredClone(reviewed), id: 'new', clientReportId: 'new-report', lotId: 'new-lot', reviews: [] };
    const before = reputationFromReviews(records, reviewed.contributorId);
    expect(reputationFromReviews([...records, copy, unreviewed], reviewed.contributorId)).toEqual(before);
    expect(deduplicateTransactions([reviewed, copy]).duplicates).toHaveLength(1);
    expect(reputationFromReviews([], 'new')).toEqual({ score: 0.5, valid: 0, invalid: 0 });
  });
  it('rejects self-review credit even when the event claims independence', () => {
    const record = structuredClone(generateSyntheticTransactions()[0]!);
    record.reviews = [{ reviewerId: record.contributorId, outcome: 'valid', independent: true, reviewedAt: '2026-10-04T08:00:00Z' }];
    expect(reputationFromReviews([record], record.contributorId)).toEqual({ score: 0.5, valid: 0, invalid: 0 });
    record.reviews.push({ reviewerId: 'different-reviewer', outcome: 'valid', independent: false, reviewedAt: '2026-10-04T08:00:00Z' });
    expect(reputationFromReviews([record], record.contributorId)).toEqual({ score: 0.5, valid: 0, invalid: 0 });
  });
  it('resolves simultaneous reviews deterministically toward invalid and allows a later valid review', () => {
    const record = structuredClone(generateSyntheticTransactions()[0]!);
    const valid = { reviewerId: 'reviewer-a', outcome: 'valid' as const, independent: true, reviewedAt: '2026-10-04T08:00:00Z' };
    const invalid = { reviewerId: 'reviewer-b', outcome: 'invalid' as const, independent: true, reviewedAt: '2026-10-04T08:00:00.000Z' };
    for (const reviews of [[valid, invalid], [invalid, valid]]) {
      record.reviews = reviews;
      expect(reputationFromReviews([record], record.contributorId)).toEqual({ score: 0.4, valid: 0, invalid: 1 });
    }
    record.reviews.push({ ...valid, reviewedAt: '2026-10-04T08:00:01Z' });
    expect(reputationFromReviews([record], record.contributorId)).toEqual({ score: 0.6, valid: 1, invalid: 0 });
  });
  it('suppresses thin source sets and retains valid unusual prices after review', () => {
    const records = generateSyntheticTransactions();
    expect(summarizeCohort(records.slice(0, 4), COHORT_SCOPES[0]!, '2026-10-04', SYNTHETIC_FX).aggregate).toBeNull();
    const result = summarizeCohort(records, COHORT_SCOPES[0]!, '2026-10-04', SYNTHETIC_FX);
    expect(result.aggregate).not.toBeNull();
    expect(result.diagnostics.includedReportIds).toContain('synthetic-093');
    expect(result.diagnostics.includedReportIds).toContain('synthetic-094');
    expect(result.diagnostics.outlierIds).toContain('synthetic-093');
    expect(result.diagnostics.maximumContributorWeight).toBeLessThanOrEqual(0.25 + 1e-10);
    expect(JSON.stringify(result.aggregate)).not.toMatch(/fictional-contributor|originalText|clientReportId|lotId/);
  });
});

describe('open evidence preparation and exact proposals', () => {
  it('keeps semantic input invariant to offer price and currency formatting', () => {
    const a = preprocessDescription('Dry Arabica parchment in closed sacks. Buyer offers TZS 300,000.');
    const b = preprocessDescription('Dry Arabica parchment in closed sacks. Buyer offers 400 000 TZS.');
    expect(a.description).toBe(b.description);
    expect(a.description).toContain('closed sacks');
    expect(a.description).not.toMatch(/300|400|TZS/);
  });
  it('excludes bare charges and loans in each demo language while preserving descriptive numbers', () => {
    const narrative = '50 kg Arabica parchment coffee. Measured moisture is 12 percent. Stored in dry sacks.';
    for (const [first, second] of [
      ['Sale costs are 0 and loan repayment is 60000.', 'Sale costs are 2500 and loan repayment is 100000.'],
      ['Les frais de vente sont 0 et le remboursement du prêt est 60000.', 'Les frais de vente sont 2500 et le remboursement du prêt est 100000.'],
      ['Gharama za mauzo ni 0 na malipo ya deni ni 60000.', 'Gharama za mauzo ni 2500 na malipo ya deni ni 100000.'],
    ]) {
      const a = preprocessDescription(`${narrative} ${first} Offer TZS 300000.`);
      const b = preprocessDescription(`${narrative} ${second} Offer TZS 900000.`);
      expect(a.description).toBe(b.description);
      expect(a.description).not.toMatch(/60000|100000|2500|300000|900000/);
      expect(a.description).toContain('50 kg'); expect(a.description).toContain('12 percent');
    }
    expect(preprocessDescription('Coffee in parchment. Crop consideration TZS 300000; charges TZS 0.').description).toBe('Coffee in parchment.');
  });
  it('excludes signed finance amounts while retaining crop measurements', () => {
    const narrative = '50 kg parchment coffee. Measured moisture is 12 percent.';
    const expected = preprocessDescription(narrative).description;
    for (const finance of ['Loan repayment is -60000.', 'Sale costs are +2,500 and loan repayment is TZS -60,000.',
      'Les frais de vente sont -2 500 et le remboursement du prêt est +60 000.',
      'Gharama za mauzo ni \u22122500 na malipo ya deni ni \u221260000.', 'Offer TZS -300000. Charges \u22126000 TZS.']) {
      expect(preprocessDescription(`${narrative} ${finance}`).description).toBe(expected);
    }
    const signed = parseExactFacts('50 kg coffee. Offer TZS -300,000. Charges TZS +2,500. Loan repayment \u221260 000 TZS.');
    expect(signed.facts.cropConsideration.value).toBe('-300000');
    expect(signed.facts.saleCosts.value).toBe('2500'); expect(signed.facts.loanSettlement.value).toBe('-60000');
  });
  it('deduplicates repeated evidence without adding confidence or losing unknown observations', () => {
    expect(preprocessDescription('Stored in a ventilated shed. Stored in a ventilated shed.')).toMatchObject({ description: 'Stored in a ventilated shed.' });
    const result = parseExactFacts('Coffee stored in a ventilated shed; packaging is unusual. 6000 TZS/kg. No charges.');
    expect(result.priceFreeNarrative).toContain('packaging is unusual');
    expect(result.facts.moisturePct.value).toBeNull();
    expect(result.facts.quotedUnitPrice.value).toBe('6000');
    expect(result.facts.quantityKg.value).toBeNull();
  });
  it('proposes French notation, preserves extraction status, and asks about sacks/conflicts', () => {
    const result = parseExactFacts('50 kg de café arabica en parche, trié. Offre 300 000 TZS. Sans frais.', { language: 'fr' });
    expect(result.facts.quantityKg.value).toBe('50'); expect(result.facts.cropConsideration.value).toBe('300000');
    expect(result.facts.saleCosts.value).toBe('0'); expect(result.facts.quantityKg.status).toBe('extracted');
    expect(parseExactFacts('2 sacks of coffee. 300000 TZS.').clarifications.some(item => item.reason === 'unknown_sack_mass')).toBe(true);
    expect(parseExactFacts('Not parchment, these are cherries. 300000 TZS.').clarifications.some(item => item.field === 'productForm')).toBe(true);
  });
  it('recognizes labeled charge and loan statements in all three demo languages', () => {
    for (const text of ['50 kg coffee, offer TZS 300000. Sale costs are 0 and loan repayment is 0.',
      '50 kg de café, offre TZS 300000. Les frais de vente sont 0 et le remboursement du prêt est 0.',
      'Kilo 50 za kahawa ya Arabika, ofa TZS 300000. Gharama za mauzo ni 0 na malipo ya deni ni 0.']) {
      const result = parseExactFacts(text);
      expect(result.facts.saleCosts.value).toBe('0'); expect(result.facts.loanSettlement.value).toBe('0');
      expect(result.facts.quantityKg.value).toBe('50'); expect(result.facts.cropConsideration.value).toBe('300000');
    }
    const loan = parseExactFacts('50 kg coffee. Offer TZS 300000; loan repayment is TZS 60000; sale costs are TZS 0.');
    expect(loan.facts.cropConsideration.value).toBe('300000'); expect(loan.facts.loanSettlement.value).toBe('60000');
    const ambiguous = parseExactFacts('50 kg coffee. Offer 300000 shillings.');
    expect(ambiguous.facts.currency.value).toBeNull(); expect(ambiguous.clarifications.some(issue => issue.reason === 'ambiguous_shillings')).toBe(true);
    const mixed = parseExactFacts('50 kg coffee. Offer TZS 300000; sale costs are USD 1.');
    expect(mixed.facts.saleCosts.value).toBeNull(); expect(mixed.clarifications.some(issue => issue.reason === 'mixed_financial_currencies')).toBe(true);
  });
  it('asks about conflicting zero declarations instead of overwriting monetary evidence', () => {
    for (const text of ['Offer TZS 300000. Charges TZS 1000. No charges.',
      'Offre TZS 300000. Frais de vente TZS 1000. Sans frais.',
      'Ofa TZS 300000. Gharama za mauzo TZS 1000. Hakuna makato.']) {
      const result = parseExactFacts(text);
      expect(result.facts.saleCosts.value).toBeNull();
      expect(result.clarifications).toContainEqual(expect.objectContaining({ field: 'saleCosts', reason: 'conflicting_financing_amounts' }));
    }
    const loan = parseExactFacts('Offer TZS 300000. Loan repayment TZS 60000. No loan.');
    expect(loan.facts.loanSettlement.value).toBeNull();
    expect(loan.clarifications).toContainEqual(expect.objectContaining({ field: 'loanSettlement', reason: 'conflicting_financing_amounts' }));
    expect(parseExactFacts('Offer TZS 300000. Charges 0. No charges.').facts.saleCosts.value).toBe('0');
    const mixed = parseExactFacts('Offer TZS 300000. Charges USD 1. No charges.');
    expect(mixed.facts.saleCosts.value).toBeNull();
    expect(mixed.clarifications).toContainEqual(expect.objectContaining({ field: 'saleCosts', reason: 'mixed_financial_currencies' }));
  });
  it('asks about explicitly negated or contradictory known critical terms', () => {
    for (const [field, texts] of [
      ['species', ['Coffee is not Arabica.', 'Arabica and Robusta coffee.', "Ce café n'est pas d'arabica.", 'Sio Arabika kahawa.']],
      ['deliveryTerms', ['Not buyer collects.', 'Buyer does not collect.', 'Buyer collects and seller delivers.']],
      ['paymentTerms', ['Not paid immediately.', 'Paid not immediately.', 'Immediate payment and paid later.', 'Pas de paiement immédiat.', 'Sio malipo ya papo hapo.']],
    ] as const) {
      for (const text of texts) {
        const result = parseExactFacts(text);
        expect(result.facts[field].value).toBeNull();
        expect(result.clarifications).toContainEqual(expect.objectContaining({ field, reason: `conflicting_or_negated_${field}` }));
      }
    }
    expect(parseExactFacts('Not sold as parchment.').clarifications).toContainEqual(expect.objectContaining({ field: 'productForm' }));
  });
  it('does not mistake an unrelated negated observation for a negated critical term', () => {
    const result = parseExactFacts('No defects on Arabica green coffee. No extra charges; buyer collects. No loan. Paid immediately.');
    expect(result.facts.species.value).toBe('arabica'); expect(result.facts.productForm.value).toBe('green');
    expect(result.facts.deliveryTerms.value).toBe('buyer_collects'); expect(result.facts.paymentTerms.value).toBe('immediate');
    expect(result.clarifications.filter(item => ['species', 'productForm', 'deliveryTerms', 'paymentTerms'].includes(item.field))).toEqual([]);
  });
});

describe('learned aggregate math', () => {
  it('bounds private reference influence after query kernel weighting and requires sufficient support', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: String(index), contributorId: `user-${Math.floor(index / 2)}`,
      price: String(100 + index * 10), preliminaryWeight: 1, vector: [1, 0] }));
    const result = comparePrivateReference([1, 0], rows, { bandwidth: 0.2, maxDistance: 0.5 });
    expect(result.status).toBe('supported');
    if (result.status !== 'supported') throw new Error('Fixture should have support');
    expect(result.quantiles.q50).toBe('140');
    expect(result.diagnostics.maximumContributorWeight).toBeCloseTo(0.2, 10);
    const changedPrices = comparePrivateReference([1, 0], rows.map(row => ({ ...row, price: '300' })), { bandwidth: 0.2, maxDistance: 0.5 });
    expect(changedPrices.status).toBe('supported');
    if (changedPrices.status === 'supported') expect(changedPrices.weights.map(row => row.weight)).toEqual(result.weights.map(row => row.weight));
    expect(comparePrivateReference([0, 1], rows, { bandwidth: 0.2, maxDistance: 0.5 })).toMatchObject({ status: 'abstain', reasons: ['too_few_similar_lots'] });
  });
  it('applies bounded adapter and rejects mismatched or invented scales', () => {
    const result = applyAdapter([1, 1], [2, 1]);
    expect(Math.hypot(...result)).toBeCloseTo(1, 6); expect(result[0]! / result[1]!).toBeCloseTo(2, 6);
    expect(() => applyAdapter([1, 1], [3, 1])).toThrow(); expect(() => applyAdapter([1, 1], [1])).toThrow();
  });
  it('decodes little-endian centroids without pretending they are unit transaction vectors', () => {
    const bytes = new Uint8Array(384 * 4); new DataView(bytes.buffer).setFloat32(0, 0.5, true);
    const vector = decodePrototype(bytes, { vector: { byteOffset: 0, dimensions: 384 } }, 'float32-le');
    expect(Math.hypot(...vector)).toBe(0.5);
  });
  it('inverts the mixed distribution instead of averaging medians', () => {
    const mixture = [ { weight: 0.75, distribution: [{ lower: '0', upper: '100', mass: 1 }] },
      { weight: 0.25, distribution: [{ lower: '1000', upper: '1100', mass: 1 }] } ];
    const median = mixtureQuantile(mixture, 0.5);
    expect(Number(median)).toBeCloseTo(66.66666667, 7);
    expect(mixtureCdf(median, mixture)).toBeCloseTo(0.5, 12);
    expect(Number(median)).not.toBe(300);
    expect(mixtureQuantile(mixture, 0.75)).toBe('100');
  });
});

describe('corpus splits and minimal evidence scoring', () => {
  it('generates 176 records with disjoint normal contributors and template families', () => {
    const { records, metadata } = generateSyntheticCorpus();
    expect(records).toHaveLength(176); expect(records.filter(record => !metadata[record.id]!.stressType)).toHaveLength(144);
    const sets = ['train', 'dev', 'test'].map(split => new Set(records.filter(record => !metadata[record.id]!.stressType && metadata[record.id]!.split === split).map(record => record.contributorId)));
    expect(sets.map(set => set.size)).toEqual([32, 8, 8]);
    expect([...sets[0]!].some(id => sets[1]!.has(id) || sets[2]!.has(id))).toBe(false);
    const templates = ['train', 'dev', 'test'].map(split => new Set(Object.values(metadata).filter(item => item.split === split).map(item => item.templateFamily)));
    expect([...templates[0]!].some(id => templates[1]!.has(id) || templates[2]!.has(id))).toBe(false);
    expect(generateSyntheticCorpus()).toEqual({ records, metadata });
  });
  it('does not award more evidence weight merely for optional observation counts', () => {
    const record: EvidenceRecord = { id: 'id', clientReportId: 'client', lotId: 'lot', contributorId: 'user', custodianId: 'coop', rawText: 'Coffee', language: 'en',
      attachmentRefs: [], observations: [], money, context: { cropId: 'coffee', marketAreaId: 'ondera-demo', date: '2026-10-04', marketTier: 'farmgate', status: 'confirmed' },
      descriptionText: 'Coffee with an unfamiliar handling observation.', consent: { upload: true, aggregateUse: true, recordedAt: '2026-10-04T08:00:00Z' }, reviewState: 'approved', synthetic: true };
    const score = evidenceRecordScore(record);
    expect(evidenceRecordScore({ ...record, observations: Array.from({ length: 100 }, (_, index) => ({ id: String(index), statement: 'Extra crop observation', polarity: 'uncertain', status: 'reported', sourceRefs: [] })) })).toEqual(score);
    const bridge = evidenceRecordToTransaction(record);
    expect(bridge.facts.moisturePct.value).toBeNull(); expect(bridge.facts.sorting.value).toBeNull();
  });
});
