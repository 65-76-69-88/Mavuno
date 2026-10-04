import { z } from 'zod';
import Decimal from 'decimal.js';
import { countBandSchema, decimalStringSchema, factStatusSchema, fxRateSchema, isoDateSchema, reviewEventSchema } from './contracts.js';

export const observationSchema = z.object({
  id: z.string(), statement: z.string(), conceptKey: z.string().optional(),
  polarity: z.enum(['positive', 'negative', 'uncertain']), status: factStatusSchema,
  sourceRefs: z.array(z.string()), modelScore: z.number().optional(),
}).strict();
export type Observation = z.infer<typeof observationSchema>;
export const moneyBasisSchema = z.object({
  amount: decimalStringSchema, currency: z.string().regex(/^[A-Z]{3}$/), basis: z.enum(['lot', 'per_kg']),
  quantityKg: decimalStringSchema.optional(), sourceQuantity: decimalStringSchema.optional(), sourceUnit: z.string().optional(),
  cropCharges: decimalStringSchema.optional(), loanSettlement: decimalStringSchema.optional(),
  status: z.enum(['proposed', 'confirmed']), sourceRefs: z.array(z.string()),
}).strict();
export type MoneyBasis = z.infer<typeof moneyBasisSchema>;
export const evidenceRecordSchema = z.object({
  id: z.string().min(1), clientReportId: z.string().min(1), lotId: z.string().min(1), contributorId: z.string().min(1), custodianId: z.string().min(1),
  rawText: z.string(), language: z.string(), attachmentRefs: z.array(z.string()), observations: z.array(observationSchema),
  money: moneyBasisSchema.optional(),
  context: z.object({ cropId: z.string().optional(), marketAreaId: z.string().optional(), date: isoDateSchema.optional(),
    marketTier: z.enum(['farmgate', 'wholesale', 'retail']).optional(), status: z.enum(['proposed', 'confirmed']).optional(), sourceRefs: z.array(z.string()).optional() }).strict(),
  descriptionText: z.string(), representation: z.object({ encoderVersion: z.string(), preprocessingVersion: z.string() }).strict().optional(),
  consent: z.object({ upload: z.boolean(), aggregateUse: z.boolean(), recordedAt: z.string().datetime() }).strict(),
  reviewState: z.enum(['unreviewed', 'approved', 'rejected', 'withdrawn']), synthetic: z.boolean(),
  verification: z.enum(['seller_reported', 'receipt_attached', 'cooperative_attested', 'independently_audited']).optional(),
  reviews: z.array(reviewEventSchema).optional(),
}).strict();
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export const histogramBinSchema = z.object({ lower: decimalStringSchema, upper: decimalStringSchema, mass: z.number().min(0).max(1) }).strict()
  .refine(bin => new Decimal(bin.upper).gt(bin.lower), 'Histogram interval must have positive width');
export type HistogramBin = z.infer<typeof histogramBinSchema>;
export const learnedGroupSchema = z.object({
  id: z.string(), vector: z.object({ byteOffset: z.number().int().nonnegative(), dimensions: z.literal(384), scale: z.number().finite().positive().optional() }).strict(),
  radius: z.number().min(0).max(2), prior: z.number().positive().max(1), distribution: z.array(histogramBinSchema).min(1),
  countBands: z.object({ lots: countBandSchema, contributors: countBandSchema, custodians: countBandSchema }).strict(),
  topics: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), reviewStatus: z.enum(['reviewed', 'synthetic_unreviewed']) }).strict()),
  context: z.object({ species: z.string().optional(), productForm: z.string().optional(), deliveryTerms: z.string().optional(), paymentTerms: z.string().optional() }).strict(),
  limitations: z.array(z.string()),
}).strict().superRefine((group, context) => {
  const mass = group.distribution.reduce((sum, bin) => sum + bin.mass, 0);
  if (Math.abs(mass - 1) > 1e-6) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Histogram masses must sum to one' });
  for (let index = 1; index < group.distribution.length; index += 1) {
    if (new Decimal(group.distribution[index]!.lower).lt(group.distribution[index - 1]!.upper))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Histogram intervals must be ordered without overlap' });
  }
});
export type LearnedGroup = z.infer<typeof learnedGroupSchema>;
export const kernelCalibrationSchema = z.object({
  status: z.enum(['pending', 'passed', 'failed']), minSimilarity: z.number().min(-1).max(1),
  minMargin: z.number().min(0).max(2), kernelTemperature: z.number().positive(), maxDistance: z.number().min(0).max(2),
}).strict();
export type KernelCalibration = z.infer<typeof kernelCalibrationSchema>;
export const packManifestSchema = z.object({
  schemaVersion: z.literal(2), packVersion: z.string(), policyVersion: z.string(),
  cropId: z.string(), regionId: z.string(), referenceBasis: z.string(),
  asOf: isoDateSchema, validUntil: isoDateSchema, synthetic: z.boolean(),
  encoderVersion: z.string(), preprocessingVersion: z.string(), adapterVersion: z.string(), dimensions: z.literal(384),
  trainingStatus: z.enum(['accepted', 'baseline']), vectorEncoding: z.enum(['int8', 'float32-le']), calibrationVersion: z.string(),
  files: z.array(z.object({ path: z.string().regex(/^(?:pack\.json|adapter\.f32|prototypes\.i8|prototypes\.f32)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), decodedBytes: z.number().int().nonnegative() }).strict()),
}).strict();
export type PackManifest = z.infer<typeof packManifestSchema>;
export const comparisonPackSchema = z.object({
  schemaVersion: z.literal(2), packVersion: z.string(), cropId: z.string(), regionId: z.string(),
  referenceBasis: z.string(), referenceCurrency: z.string(), referenceUnit: z.literal('kg'), rounding: decimalStringSchema,
  asOf: isoDateSchema, validUntil: isoDateSchema,
  scope: z.object({ marketTier: z.enum(['farmgate', 'wholesale', 'retail']), description: z.string() }).strict(),
  fxRates: z.array(fxRateSchema), calibration: kernelCalibrationSchema, groups: z.array(learnedGroupSchema),
  disclosure: z.object({ synthetic: z.boolean(), limitations: z.array(z.string()) }).strict(),
}).strict().superRefine((pack, context) => {
  if (!pack.groups.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Pack needs at least one published group' });
  if (new Set(pack.groups.map(group => group.id)).size !== pack.groups.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate group IDs' });
  if (Math.abs(pack.groups.reduce((sum, group) => sum + group.prior, 0) - 1) > 1e-6)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Group priors must sum to one' });
});
export type ComparisonPack = z.infer<typeof comparisonPackSchema>;
