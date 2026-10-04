import type { CohortScope, CropProfile, SaleFactKey } from './contracts.js';

export const POLICY_VERSION = 'synthetic-coffee-v2-rounding-cap';
export const PROFILE_VERSION = 'coffee-ondera-v1';
export const REQUIRED_FACTS: SaleFactKey[] = ['cropId', 'species', 'productForm', 'quantityKg', 'saleDate',
  'marketAreaId', 'saleChannel', 'deliveryTerms', 'paymentTerms', 'currency', 'priceBasis', 'saleCosts'];
export const COHORT_SCOPES: CohortScope[] = (['small', 'medium'] as const).flatMap(lotBand =>
  (['sorted', 'mixed'] as const).map(sorting => ({ cropId: 'coffee', species: 'arabica', productForm: 'parchment',
    marketAreaId: 'ondera-demo', saleChannel: 'farmgate', deliveryTerms: 'buyer_collects',
    paymentTerms: 'immediate', lotBand, sorting })));
export const COFFEE_PROFILE: CropProfile = {
  id: 'coffee', version: PROFILE_VERSION, regionId: 'ondera-demo', referenceCurrency: 'TZS',
  requiredFacts: REQUIRED_FACTS, scopes: COHORT_SCOPES,
  publication: { minimumLots: 10, minimumContributors: 5, minimumTransactionEffectiveN: 5,
    minimumContributorEffectiveN: 4, contributorCap: 0.25, windowDays: 90, expiryDays: 14, rounding: '50' },
};
export function cohortId(scope: CohortScope): string { return `${scope.lotBand}-${scope.sorting}`; }
export function cohortDescriptor(scope: CohortScope): string {
  return `${scope.lotBand === 'small' ? 'Small' : 'Medium'} lot of dry Arabica parchment coffee. ${scope.sorting === 'sorted'
    ? 'Hand sorted, uniform clean parchment beans with visible defects removed.'
    : 'Mixed unsorted parchment beans, uneven sizes with visible defects remaining.'} Farmgate sale, buyer collects, immediate payment.`;
}
