import { z } from 'zod';

/** Decimal strings prevent binary floating-point rounding in money calculations. */
export const decimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/, 'Use an explicit decimal amount');
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
export const factStatusSchema = z.enum(['reported', 'extracted', 'confirmed', 'attested']);
export const factSchema = <T extends z.ZodType>(value: T) => z.object({
  value: value.nullable(), status: factStatusSchema, sourceRefs: z.array(z.string()),
  extractionScore: z.number().min(0).max(1).optional(),
}).strict();
export type Fact<T> = { value: T | null; status: z.infer<typeof factStatusSchema>; sourceRefs: string[]; extractionScore?: number };
const textFact = factSchema(z.string());
const decimalFact = factSchema(decimalStringSchema);
export const saleFactsSchema = z.object({
  cropId: textFact, species: textFact, productForm: textFact,
  sourceQuantity: decimalFact, sourceUnit: textFact, quantityKg: decimalFact,
  saleDate: factSchema(isoDateSchema), marketAreaId: textFact,
  saleChannel: textFact, deliveryTerms: textFact, paymentTerms: textFact,
  currency: factSchema(z.string().regex(/^[A-Z]{3}$/)),
  priceBasis: factSchema(z.enum(['lot', 'per_kg'])),
  quotedUnitPrice: decimalFact, cropConsideration: decimalFact,
  saleCosts: decimalFact, loanSettlement: decimalFact,
  moisturePct: decimalFact, sorting: textFact,
}).strict();
export type SaleFacts = z.infer<typeof saleFactsSchema>;
export type SaleFactKey = keyof SaleFacts;

export const reviewEventSchema = z.object({
  reviewerId: z.string().min(1), outcome: z.enum(['valid', 'invalid']),
  reviewedAt: z.string().datetime(), independent: z.boolean(), reason: z.string().optional(),
}).strict();
export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export const privateTransactionSchema = z.object({
  id: z.string().min(1), clientReportId: z.string().min(1), contributorId: z.string().min(1),
  cooperativeId: z.string().min(1), lotId: z.string().min(1), facts: saleFactsSchema,
  originalText: z.string(), inputLanguage: z.string(), evidenceRefs: z.array(z.string()),
  consent: z.object({ upload: z.boolean(), aggregateUse: z.boolean(), recordedAt: z.string().datetime() }).strict(),
  reviewState: z.enum(['unreviewed', 'approved', 'rejected', 'withdrawn']),
  verification: z.enum(['seller_reported', 'receipt_attached', 'cooperative_attested', 'independently_audited']),
  reviews: z.array(reviewEventSchema), synthetic: z.boolean(),
}).strict();
export type PrivateTransaction = z.infer<typeof privateTransactionSchema>;

export const fxRateSchema = z.object({
  date: isoDateSchema, baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  rates: z.record(z.string(), decimalStringSchema), quoteDirection: z.literal('currency_per_base'),
  provider: z.string(), license: z.string(), synthetic: z.boolean(),
}).strict();
export type FxRate = z.infer<typeof fxRateSchema>;
export const lotBandSchema = z.enum(['small', 'medium']);
export type LotBand = z.infer<typeof lotBandSchema>;
export const cohortScopeSchema = z.object({
  cropId: z.string(), species: z.string(), productForm: z.string(), marketAreaId: z.string(),
  saleChannel: z.string(), deliveryTerms: z.string(), paymentTerms: z.string(),
  lotBand: lotBandSchema, sorting: z.enum(['sorted', 'mixed']),
}).strict();
export type CohortScope = z.infer<typeof cohortScopeSchema>;
export type CropProfile = {
  id: string; version: string; regionId: string; referenceCurrency: string;
  requiredFacts: SaleFactKey[]; scopes: CohortScope[];
  publication: { minimumLots: number; minimumContributors: number; minimumTransactionEffectiveN: number;
    minimumContributorEffectiveN: number; contributorCap: number; windowDays: number; expiryDays: number;
    rounding: string };
};
export const countBandSchema = z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }).strict();
export type CountBand = z.infer<typeof countBandSchema>;
export const aggregateCohortSchema = z.object({
  id: z.string(), scope: cohortScopeSchema, descriptor: z.string(),
  vector: z.object({ byteOffset: z.number().int().nonnegative(), dimensions: z.literal(384), scale: z.number().positive().optional() }).strict(),
  quantiles: z.object({ q25: decimalStringSchema, q50: decimalStringSchema, q75: decimalStringSchema }).strict(),
  countBands: z.object({ lots: countBandSchema, contributors: countBandSchema, cooperatives: countBandSchema }).strict(),
  observationWindow: z.object({ from: isoDateSchema, to: isoDateSchema }).strict(),
  qualityCoverage: z.object({ measuredMoisture: z.enum(['none', 'partial', 'broad']), limitations: z.array(z.string()) }).strict(),
  publication: z.object({ eligible: z.literal(true), policyVersion: z.string(), rounding: decimalStringSchema }).strict(),
  synthetic: z.boolean(),
}).strict();
export type AggregateCohort = z.infer<typeof aggregateCohortSchema>;
export const legacyPackManifestSchema = z.object({
  schemaVersion: z.literal(1), cropProfileVersion: z.string(), packVersion: z.string(),
  cropId: z.string(), regionId: z.string(), marketTier: z.literal('local'),
  asOf: isoDateSchema, publishedAt: z.string().datetime(), validUntil: isoDateSchema,
  encoder: z.object({ artifactRevision: z.string(), dimensions: z.literal(384), prefix: z.literal('query: ') }).strict(),
  vectorEncoding: z.enum(['int8', 'float32-le']), policyVersion: z.string(), calibrationVersion: z.string(),
  calibration: z.object({ status: z.enum(['pending', 'passed', 'failed']), semanticMin: z.number().min(-1).max(1), marginMin: z.number().min(0).max(2) }).strict(),
  files: z.array(z.object({ path: z.string().regex(/^(?:pack\.json|vectors\.i8|vectors\.f32)$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), decodedBytes: z.number().int().nonnegative() }).strict()),
  synthetic: z.boolean(),
}).strict();
export type LegacyPackManifest = z.infer<typeof legacyPackManifestSchema>;
export const legacyComparisonPackSchema = z.object({
  schemaVersion: z.literal(1), packVersion: z.string(), cropProfileVersion: z.string(),
  cropId: z.string(), regionId: z.string(), asOf: isoDateSchema, validUntil: isoDateSchema,
  referenceCurrency: z.string(), referenceUnit: z.literal('kg'), rounding: decimalStringSchema,
  fxRates: z.array(fxRateSchema), cohorts: z.array(aggregateCohortSchema),
  disclosure: z.object({ synthetic: z.boolean(), limitations: z.array(z.string()) }).strict(),
}).strict();
export type LegacyComparisonPack = z.infer<typeof legacyComparisonPackSchema>;

export type Clarification = { field: SaleFactKey | 'description'; reason: string; question: string };
export type ParsedInput = { facts: SaleFacts; clarifications: Clarification[]; priceFreeNarrative: string; language: string };
export type ComparisonResult =
  | { status: 'comparison'; cohortId: string; referenceCurrency: string; offerPerKg: string; median: string;
      middle50: { lower: string; upper: string }; offerDeltaPct: string; limitations: string[]; nextStep: string }
  | { status: 'clarify' | 'abstain'; reasons: string[]; nextStep: string };

export function fact<T>(value: T | null, status: Fact<T>['status'] = 'reported', sourceRefs: string[] = []): Fact<T> {
  return { value, status, sourceRefs };
}
export function emptySaleFacts(): SaleFacts {
  return {
    cropId: fact(null), species: fact(null), productForm: fact(null), sourceQuantity: fact(null),
    sourceUnit: fact(null), quantityKg: fact(null), saleDate: fact(null), marketAreaId: fact(null),
    saleChannel: fact(null), deliveryTerms: fact(null), paymentTerms: fact(null), currency: fact(null),
    priceBasis: fact(null), quotedUnitPrice: fact(null), cropConsideration: fact(null), saleCosts: fact(null),
    loanSettlement: fact(null), moisturePct: fact(null), sorting: fact(null),
  };
}
/** Explicit confirmation is separate from extraction, even for a recognisable numeric value. */
export function confirmFacts(facts: SaleFacts, fields: SaleFactKey[] = Object.keys(facts) as SaleFactKey[]): SaleFacts {
  const result = structuredClone(facts);
  for (const field of fields) if (result[field].value !== null) result[field].status = 'confirmed';
  return result;
}
