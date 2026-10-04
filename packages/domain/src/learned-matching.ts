import Decimal from 'decimal.js';
import type { HistogramBin, LearnedGroup } from './learned-contracts.js';

export function normalizeVector(vector: ArrayLike<number>): Float32Array {
  const values = Array.from(vector);
  if (values.some(value => !Number.isFinite(value))) throw new Error('Vector must be finite');
  const norm = Math.hypot(...values);
  if (norm === 0) throw new Error('Cannot normalize a zero vector');
  return Float32Array.from(values, value => value / norm);
}
export function applyAdapter(vector: ArrayLike<number>, scales: ArrayLike<number>): Float32Array {
  if (vector.length !== scales.length || vector.length === 0) throw new Error('Adapter dimension mismatch');
  const result = Array.from(vector, (value, index) => {
    const scale = scales[index]!;
    if (!Number.isFinite(scale) || scale < 0.5 - 1e-6 || scale > 2 + 1e-6) throw new Error('Adapter scale outside declared bounds');
    return value * scale;
  });
  return normalizeVector(result);
}
export function euclideanDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) throw new Error('Vector dimension mismatch');
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (!Number.isFinite(a[index]) || !Number.isFinite(b[index])) throw new Error('Non-finite vector');
    sum += (a[index]! - b[index]!) ** 2;
  }
  return Math.sqrt(sum);
}
/** Centroids deliberately remain unnormalized: their norm represents group spread. */
export function decodePrototype(bytes: ArrayBuffer | Uint8Array, group: Pick<LearnedGroup, 'vector'>, encoding: 'int8' | 'float32-le'): Float32Array {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { byteOffset, dimensions, scale } = group.vector;
  const stride = encoding === 'int8' ? 1 : 4;
  if (byteOffset + dimensions * stride > source.byteLength) throw new Error('Truncated prototype vector');
  const result = new Float32Array(dimensions);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (encoding === 'int8' && (!scale || !Number.isFinite(scale) || scale <= 0)) throw new Error('Invalid quantization scale');
  for (let index = 0; index < dimensions; index += 1) result[index] = encoding === 'int8'
    ? view.getInt8(byteOffset + index) * scale! : view.getFloat32(byteOffset + index * 4, true);
  if ([...result].some(value => !Number.isFinite(value))) throw new Error('Invalid prototype value');
  return result;
}
export function decodeAdapter(bytes: ArrayBuffer | Uint8Array, dimensions = 384): Float32Array {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (source.byteLength !== dimensions * 4) throw new Error('Adapter byte length mismatch');
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const scales = Float32Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true));
  if ([...scales].some(value => !Number.isFinite(value) || value < 0.5 || value > 2)) throw new Error('Invalid adapter scale');
  return scales;
}
export function kernelGroupWeights(query: ArrayLike<number>, groups: { id: string; prior: number; radius: number; vector: ArrayLike<number> }[], bandwidth: number, maxDistance: number): { id: string; distance: number; weight: number }[] {
  if (!Number.isFinite(bandwidth) || bandwidth <= 0 || maxDistance < 0) throw new Error('Invalid kernel calibration');
  const supported = groups.map(group => ({ id: group.id, distance: euclideanDistance(query, group.vector), prior: group.prior }))
    .filter(group => group.distance <= maxDistance && group.prior > 0);
  if (!supported.length) return [];
  // Shift log weights to prevent underflow when every supported distance is relatively large.
  const logs = supported.map(group => Math.log(group.prior) - group.distance ** 2 / (2 * bandwidth ** 2));
  const maximum = Math.max(...logs); const masses = logs.map(value => Math.exp(value - maximum));
  const total = masses.reduce((sum, value) => sum + value, 0);
  return supported.map((group, index) => ({ id: group.id, distance: group.distance, weight: masses[index]! / total }));
}
export type HistogramMixture = { weight: number; distribution: HistogramBin[] }[];
export function mixtureCdf(price: string, mixture: HistogramMixture): number {
  const value = new Decimal(price); const totalWeight = mixture.reduce((sum, group) => sum + group.weight, 0);
  if (totalWeight <= 0) throw new Error('Mixture needs positive mass');
  return mixture.reduce((cdf, group) => {
    if (!Number.isFinite(group.weight) || group.weight < 0) throw new Error('Invalid mixture weight');
    const totalMass = group.distribution.reduce((sum, bin) => sum + bin.mass, 0);
    if (totalMass <= 0) throw new Error('Histogram needs positive mass');
    const groupCdf = group.distribution.reduce((sum, bin) => {
      const width = new Decimal(bin.upper).sub(bin.lower);
      if (width.lte(0) || !Number.isFinite(bin.mass) || bin.mass < 0) throw new Error('Invalid histogram bin');
      const fraction = Decimal.min(1, Decimal.max(0, value.sub(bin.lower).div(width))).toNumber();
      return sum + bin.mass / totalMass * fraction;
    }, 0);
    return cdf + group.weight / totalWeight * groupCdf;
  }, 0);
}
/** Inverse CDF over all interval boundaries, assuming uniform mass inside each released interval. */
export function mixtureQuantile(mixture: HistogramMixture, probability: number): string {
  if (probability < 0 || probability > 1) throw new Error('Invalid quantile probability');
  const boundaries = [...new Set(mixture.filter(group => group.weight > 0).flatMap(group => group.distribution
    .filter(bin => bin.mass > 0).flatMap(bin => [bin.lower, bin.upper])))].sort((a, b) => new Decimal(a).cmp(b));
  if (!boundaries.length) throw new Error('Empty mixture');
  if (probability === 0) return boundaries[0]!;
  for (let index = 1; index < boundaries.length; index += 1) {
    const lower = boundaries[index - 1]!; const upper = boundaries[index]!;
    const lowerCdf = mixtureCdf(lower, mixture); const upperCdf = mixtureCdf(upper, mixture);
    if (upperCdf + 1e-12 >= probability && upperCdf > lowerCdf) {
      const fraction = Math.max(0, Math.min(1, (probability - lowerCdf) / (upperCdf - lowerCdf)));
      return new Decimal(lower).add(new Decimal(upper).sub(lower).mul(String(fraction))).toFixed();
    }
  }
  return boundaries.at(-1)!;
}
export function mixtureQuantiles(mixture: HistogramMixture): { q25: string; q50: string; q75: string } {
  return { q25: mixtureQuantile(mixture, 0.25), q50: mixtureQuantile(mixture, 0.5), q75: mixtureQuantile(mixture, 0.75) };
}
