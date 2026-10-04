import { euclideanDistance } from './learned-matching.js';
import { capContributorWeights, effectiveSampleSize, weightedQuantile, type WeightedPrice } from './statistics.js';

export type PrivateReferenceRow = Omit<WeightedPrice, 'weight'> & { vector: ArrayLike<number> };
export type PrivateReferenceResult =
  | { status: 'supported'; quantiles: { q25: string; q50: string; q75: string }; weights: WeightedPrice[];
      diagnostics: { lots: number; contributors: number; transactionEffectiveN: number; contributorEffectiveN: number; maximumContributorWeight: number } }
  | { status: 'abstain'; reasons: string[] };
/** Private validation only. Callers must apply consent, review, context, date and deduplication first. */
export function comparePrivateReference(query: ArrayLike<number>, rows: PrivateReferenceRow[], calibration: {
  bandwidth: number; maxDistance: number; contributorCap?: number; minimumLots?: number; minimumContributors?: number;
}): PrivateReferenceResult {
  if (!Number.isFinite(calibration.bandwidth) || calibration.bandwidth <= 0 || !Number.isFinite(calibration.maxDistance) || calibration.maxDistance < 0) throw new Error('Invalid private calibration');
  const supported = rows.map(row => ({ row, distance: euclideanDistance(query, row.vector) }))
    .filter(item => item.distance <= calibration.maxDistance);
  const contributors = new Set(supported.map(item => item.row.contributorId));
  if (supported.length < (calibration.minimumLots ?? 10)) return { status: 'abstain', reasons: ['too_few_similar_lots'] };
  if (contributors.size < (calibration.minimumContributors ?? 5)) return { status: 'abstain', reasons: ['too_few_similar_contributors'] };
  const logs = supported.map(({ row, distance }) => Math.log(row.preliminaryWeight) - distance ** 2 / (2 * calibration.bandwidth ** 2));
  const maximum = Math.max(...logs);
  const prices = supported.map(({ row }, index) => ({ id: row.id, contributorId: row.contributorId, price: row.price,
    preliminaryWeight: Math.exp(logs[index]! - maximum) }));
  const weights = capContributorWeights(prices, calibration.contributorCap ?? 0.25);
  const shares = new Map<string, number>();
  for (const row of weights) shares.set(row.contributorId, (shares.get(row.contributorId) ?? 0) + row.weight);
  const transactionEffectiveN = effectiveSampleSize(weights.map(row => row.weight));
  const contributorEffectiveN = effectiveSampleSize([...shares.values()]);
  const maximumContributorWeight = Math.max(...shares.values());
  if (transactionEffectiveN < 5 || contributorEffectiveN < 4) return { status: 'abstain', reasons: ['insufficient_effective_support'] };
  return { status: 'supported', quantiles: { q25: weightedQuantile(weights, 0.25), q50: weightedQuantile(weights, 0.5), q75: weightedQuantile(weights, 0.75) }, weights,
    diagnostics: { lots: weights.length, contributors: contributors.size, transactionEffectiveN, contributorEffectiveN, maximumContributorWeight } };
}
