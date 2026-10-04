/** Independent TypeScript check of final publisher artifacts against a private record comparator.
 * Run after assets:prepare: npx tsx tests/evaluation/run.ts
 * Outputs stay in generated/; none of the source rows or encoder vectors is a browser asset.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { applyAdapter, comparePrivateReference, daysBetween, decodePrototype, euclideanDistance, kernelGroupWeights,
  mixtureQuantiles, normalizeSale, preprocessDescription, reputationFromReviews, parseExactFacts, type PrivateReferenceRow } from '@pricemesh/domain';
import { buildComparisonPack, learnedModelSchema, sourceEvidenceScore } from '@pricemesh/pack';
import { generateSyntheticCorpus, syntheticRelation, type CorpusMetadata } from '../../fixtures/synthetic/corpus.js';
import { SYNTHETIC_FX } from '../../fixtures/synthetic/generate.js';
import { generateLanguageCases } from '../../fixtures/synthetic/language-cases.js';
import { encodeDescription, disposeEncoder, ENCODER_VERSION } from '../../training/encoder.js';

type Cache = { encoderVersion: string; preprocessingVersion: string; records: { id: string; embedding: number[]; descriptionHash: string }[] };
const asOf = '2026-10-04';
const cacheBytes = await readFile('generated/embedding-cache.json'); const cache = JSON.parse(cacheBytes.toString()) as Cache;
const modelBytes = await readFile('generated/learned-groups.json'); const model = learnedModelSchema.parse(JSON.parse(modelBytes.toString()));
if (cache.encoderVersion !== model.encoderVersion || cache.encoderVersion !== ENCODER_VERSION || cache.preprocessingVersion !== model.preprocessingVersion) throw new Error('Model/cache/preprocessing versions disagree.');
const corpus = generateSyntheticCorpus();
const adapted = new Map(cache.records.map(record => [record.id, Array.from(applyAdapter(record.embedding, model.adapter))]));
const stale = corpus.records.filter(record => {
  const found = cache.records.find(item => item.id === record.id);
  return !found || found.descriptionHash !== createHash('sha256').update(preprocessDescription(record.originalText).description).digest('hex');
});
if (stale.length) throw new Error(`Cache descriptions need regeneration for: ${stale.map(record => record.id).join(', ')}`);
const packBuild = buildComparisonPack({ transactions: corpus.records, fxRates: SYNTHETIC_FX, asOf,
  packVersion: 'evaluation-frozen-v3', model, representations: adapted });
const included = new Set(packBuild.memberships.filter(item => item.included).map(item => item.reportId));
const references: PrivateReferenceRow[] = corpus.records.filter(record => included.has(record.id)).map(record => {
  const normalization = normalizeSale(record.facts, 'TZS', SYNTHETIC_FX);
  if (!normalization.ok) throw new Error(`Publisher included invalid arithmetic for ${record.id}`);
  const preliminaryWeight = sourceEvidenceScore(record).score / 100 * reputationFromReviews(corpus.records, record.contributorId).score * 2 ** (-daysBetween(record.facts.saleDate.value!, asOf) / 30);
  return { id: record.id, contributorId: record.contributorId, price: normalization.value.netCropPrice, preliminaryWeight, vector: adapted.get(record.id)! };
});
const prototypes = packBuild.files.get('prototypes.f32')!;
const groups = packBuild.pack.groups.map(group => ({ ...group, vector: decodePrototype(prototypes, group, 'float32-le') }));
const publicResult = (query: ArrayLike<number>) => {
  const weights = kernelGroupWeights(query, groups, model.calibration.kernelTemperature, model.calibration.maxDistance);
  if (!weights.length) return null;
  return mixtureQuantiles(weights.map(weight => ({ weight: weight.weight, distribution: packBuild.pack.groups.find(group => group.id === weight.id)!.distribution })));
};
const approximationCases: { id: string; split: string; privateMedian: number | null; publicMedian: number | null; error: number | null; reasons: string[] }[] = [];
for (const record of corpus.records.filter(record => !corpus.metadata[record.id]!.stressType && corpus.metadata[record.id]!.split !== 'train')) {
  const query = adapted.get(record.id)!;
  const exact = comparePrivateReference(query, references, { bandwidth: model.calibration.kernelTemperature, maxDistance: model.calibration.maxDistance });
  const aggregate = publicResult(query);
  approximationCases.push({ id: record.id, split: corpus.metadata[record.id]!.split,
    privateMedian: exact.status === 'supported' ? Number(exact.quantiles.q50) : null, publicMedian: aggregate ? Number(aggregate.q50) : null,
    error: exact.status === 'supported' && aggregate ? Math.abs(Number(exact.quantiles.q50) - Number(aggregate.q50)) : null,
    reasons: exact.status === 'abstain' ? exact.reasons : [] });
}
function quantile(values: number[], probability: number): number | null {
  const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability; const low = Math.floor(index); const high = Math.ceil(index);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}
const approximation = Object.fromEntries(['dev', 'test'].map(split => {
  const cases = approximationCases.filter(item => item.split === split); const errors = cases.flatMap(item => item.error === null ? [] : [item.error]);
  return [split, { cases: cases.length, supported: errors.length, coverage: errors.length / cases.length,
    medianAbsoluteError: quantile(errors, 0.5), p90AbsoluteError: quantile(errors, 0.9), maximumAbsoluteError: errors.length ? Math.max(...errors) : null }];
}));
const lexicalTokens = (text: string) => new Set(preprocessDescription(text).description.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? []);
function lexicalScore(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter(token => right.has(token)).length;
  return intersection / Math.max(1, new Set([...left, ...right]).size);
}
const normalTraining = corpus.records.filter(record => corpus.metadata[record.id]!.split === 'train' && !corpus.metadata[record.id]!.stressType);
const languageCases = generateLanguageCases(); const languageOutputs: object[] = [];
const runtimeStart = performance.now();
for (const [index, testCase] of languageCases.entries()) {
  const base = await encodeDescription(testCase.text); const query = applyAdapter(base, model.adapter);
  const prepared = preprocessDescription(testCase.text); const proposed = parseExactFacts(testCase.text, { language: testCase.language });
  const criticalClarifications = proposed.clarifications.filter(issue => ['species', 'productForm', 'deliveryTerms', 'paymentTerms', 'quantityKg', 'cropConsideration', 'description'].includes(issue.field));
  const knownConflict = (proposed.facts.productForm.value !== null && proposed.facts.productForm.value !== 'parchment') || proposed.facts.paymentTerms.value === 'deferred' || proposed.facts.deliveryTerms.value === 'seller_delivers';
  const beforeGuard = publicResult(query);
  const result = criticalClarifications.length || knownConflict ? null : beforeGuard;
  const tokenSet = lexicalTokens(testCase.text);
  const relevance = testCase.metadata ? new Set(normalTraining.filter(record => syntheticRelation(testCase.metadata!, corpus.metadata[record.id]!) === 'comparable').map(record => record.id)) : null;
  const ranked = normalTraining.map(record => ({ id: record.id, distance: euclideanDistance(query, adapted.get(record.id)!) })).sort((a, b) => a.distance - b.distance).slice(0, 5);
  const lexicalRanked = normalTraining.map(record => ({ id: record.id, score: lexicalScore(tokenSet, lexicalTokens(record.originalText)) })).sort((a, b) => b.score - a.score).slice(0, 5);
  const retrieved = relevance ? ranked.filter(item => relevance.has(item.id)).length : null;
  const lexicalRetrieved = relevance ? lexicalRanked.filter(item => relevance.has(item.id)).length : null;
  languageOutputs.push({ id: testCase.id, family: testCase.family, split: testCase.split, language: testCase.language, expected: testCase.expected,
    semanticReferenceSupported: result !== null, referenceSupportedBeforeGuard: beforeGuard !== null,
    proposedCriticalClarifications: criticalClarifications.map(item => item.reason), knownConflict,
    approximateMedian: result ? Number(result.q50) : null, relevantTrainingCount: relevance?.size ?? null,
    precisionAt5: retrieved === null ? null : retrieved / 5, recallAt5: retrieved === null || !relevance?.size ? null : retrieved / relevance.size,
    lexicalPrecisionAt5: lexicalRetrieved === null ? null : lexicalRetrieved / 5, reviewStatus: testCase.reviewStatus, limitation: testCase.limitation,
    preprocessingIssues: prepared.issues });
  if ((index + 1) % 16 === 0) console.log(`Evaluated ${index + 1}/${languageCases.length} multilingual evidence descriptions using actual q8 inference`);
}
type LanguageOutput = { language: string; split: string; expected: string; semanticReferenceSupported: boolean; referenceSupportedBeforeGuard: boolean; precisionAt5: number | null; recallAt5: number | null; lexicalPrecisionAt5: number | null };
const byLanguage = Object.fromEntries(['en', 'fr', 'sw'].map(language => {
  const cases = (languageOutputs as LanguageOutput[]).filter(item => item.language === language);
  const summarize = (subset: LanguageOutput[]) => {
    const average = (key: 'precisionAt5' | 'recallAt5' | 'lexicalPrecisionAt5') => {
      const values = subset.flatMap(item => item[key] === null ? [] : [item[key]!]); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    return { cases: subset.length, supported: subset.filter(item => item.semanticReferenceSupported).length,
      labeledRelevanceCases: subset.filter(item => item.precisionAt5 !== null).length, precisionAt5: average('precisionAt5'), recallAt5: average('recallAt5'), lexicalPrecisionAt5: average('lexicalPrecisionAt5'),
      expectedComparisonCases: subset.filter(item => item.expected === 'comparison').length,
      unsupportedExpectedComparisons: subset.filter(item => item.expected === 'comparison' && !item.semanticReferenceSupported).length,
      unexpectedReferences: subset.filter(item => item.expected !== 'comparison' && item.semanticReferenceSupported).length,
      supportedBeforeGuard: subset.filter(item => item.referenceSupportedBeforeGuard).length,
      unexpectedReferencesBeforeGuard: subset.filter(item => item.expected !== 'comparison' && item.referenceSupportedBeforeGuard).length };
  };
  return [language, { ...summarize(cases), bySplit: Object.fromEntries(['dev', 'test'].map(split => [split, summarize(cases.filter(item => item.split === split))])) }];
}));
const report = { synthetic: true, independentReview: false, frozenModel: { adapterVersion: model.adapterVersion, trainingStatus: model.trainingStatus,
  preprocessingVersion: model.preprocessingVersion, calibrationVersion: model.calibrationVersion,
  cacheSha256: createHash('sha256').update(cacheBytes).digest('hex'), modelSha256: createHash('sha256').update(modelBytes).digest('hex') },
  scope: 'Independent TypeScript final-publisher approximation; separately, actual multilingual inference and synthetic rule retrieval evaluation. Monetary confirmation is evaluated in domain tests, not assumed from description-only query variants.',
  publication: packBuild.diagnostics, approximation, approximationCases, languages: byLanguage, languageCases: languageOutputs,
  actualMultilingualInferenceMs: performance.now() - runtimeStart,
  limitations: ['All source prices, comparison labels and attestations are fictional.', 'Synthetic generated relevance is not independent agricultural comparability judgment.',
    'Ranking precision is computed before monetary/context guards; supported results separately report guard effects.',
    'French translations are team-authored but not independently reviewed; Kiswahili has no fluent agricultural reviewer.', 'Models/calibration are frozen before this report; no test-driven retuning occurs.',
    'English/French queries are 12 development and 20 held-out intent families with linked language variants; six Kiswahili cases are separate provisional interactions.'] };
await writeFile('generated/evaluation-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ approximation, languages: byLanguage, publication: packBuild.diagnostics, actualMultilingualInferenceSeconds: report.actualMultilingualInferenceMs / 1000 }));
await disposeEncoder();
