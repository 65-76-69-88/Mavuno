import Decimal from 'decimal.js';
import type { FxRate, SaleFacts } from './contracts.js';
import { isoDateSchema } from './contracts.js';
import { moneyBasisSchema, type MoneyBasis } from './learned-contracts.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export function daysBetween(earlier: string, later: string): number {
  isoDateSchema.parse(earlier); isoDateSchema.parse(later);
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}
export function addDays(date: string, days: number): string {
  isoDateSchema.parse(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export type ConversionResult =
  | { ok: true; amount: string; fixing: FxRate | null }
  | { ok: false; reasons: string[] };
export function convertCurrency(amount: string, from: string, to: string, date: string, rates: FxRate[], maxAgeDays = 7): ConversionResult {
  let value: Decimal;
  try { value = new Decimal(amount); } catch { return { ok: false, reasons: ['invalid_amount'] }; }
  if (!value.isFinite()) return { ok: false, reasons: ['invalid_amount'] };
  if (!isoDateSchema.safeParse(date).success) return { ok: false, reasons: ['invalid_date'] };
  if (from === to) return { ok: true, amount: value.toFixed(), fixing: null };
  const fixing = rates.filter(rate => rate.date <= date &&
    (from === rate.baseCurrency || rate.rates[from] !== undefined) &&
    (to === rate.baseCurrency || rate.rates[to] !== undefined))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!fixing) return { ok: false, reasons: ['missing_fx_pair'] };
  if (daysBetween(fixing.date, date) > maxAgeDays) return { ok: false, reasons: ['stale_fx_rate'] };
  const fromRate = new Decimal(from === fixing.baseCurrency ? '1' : fixing.rates[from]!);
  const toRate = new Decimal(to === fixing.baseCurrency ? '1' : fixing.rates[to]!);
  if (!fromRate.isFinite() || !toRate.isFinite() || fromRate.lte(0) || toRate.lte(0))
    return { ok: false, reasons: ['invalid_fx_rate'] };
  return { ok: true, amount: value.mul(toRate).div(fromRate).toFixed(), fixing };
}
export type NormalizedSale = {
  quantityKg: string; netCropPrice: string; settlementCash: string | null;
  cropConsideration: string; originalCurrency: string; referenceCurrency: string; fx: FxRate | null;
};
export type NormalizationResult = { ok: true; value: NormalizedSale } | { ok: false; reasons: string[] };
const confirmed = (status: string) => status === 'confirmed' || status === 'attested';
/** Crop consideration and financing settlement deliberately follow different calculations. */
export function normalizeSale(facts: SaleFacts, referenceCurrency: string, rates: FxRate[]): NormalizationResult {
  const reasons: string[] = [];
  for (const field of ['quantityKg', 'currency', 'saleDate', 'priceBasis', 'saleCosts'] as const) {
    if (facts[field].value === null) reasons.push(`missing_${field}`);
    else if (!confirmed(facts[field].status)) reasons.push(`unconfirmed_${field}`);
  }
  const priceField = facts.priceBasis.value === 'per_kg' ? 'quotedUnitPrice' : 'cropConsideration';
  if (facts[priceField].value === null) reasons.push(`missing_${priceField}`);
  else if (!confirmed(facts[priceField].status)) reasons.push(`unconfirmed_${priceField}`);
  if (reasons.length) return { ok: false, reasons };
  try {
    const quantity = new Decimal(facts.quantityKg.value!);
    const saleCosts = new Decimal(facts.saleCosts.value!);
    const consideration = facts.priceBasis.value === 'per_kg'
      ? new Decimal(facts.quotedUnitPrice.value!).mul(quantity)
      : new Decimal(facts.cropConsideration.value!);
    if (!quantity.isFinite() || quantity.lte(0)) reasons.push('invalid_quantity');
    if (!saleCosts.isFinite() || saleCosts.lt(0)) reasons.push('invalid_sale_costs');
    if (!consideration.isFinite() || consideration.lte(0) || saleCosts.gte(consideration)) reasons.push('invalid_crop_consideration');
    // A source-unit mismatch cannot be disguised as a confirmed normalized quantity.
    if (facts.sourceQuantity.value !== null && facts.sourceUnit.value !== null && facts.sourceUnit.value !== 'sack') {
      const factor = { kg: '1', tonne: '1000', lb: '0.45359237' }[facts.sourceUnit.value];
      if (!factor) reasons.push('unsupported_unit');
      else if (!new Decimal(facts.sourceQuantity.value).mul(factor).eq(quantity)) reasons.push('quantity_unit_conflict');
    }
    if (reasons.length) return { ok: false, reasons };
    const net = consideration.sub(saleCosts);
    const converted = convertCurrency(net.div(quantity).toFixed(), facts.currency.value!, referenceCurrency, facts.saleDate.value!, rates);
    if (!converted.ok) return converted;
    let settlementCash: string | null = null;
    if (facts.loanSettlement.value !== null && confirmed(facts.loanSettlement.status)) {
      const loan = new Decimal(facts.loanSettlement.value);
      if (!loan.isFinite() || loan.lt(0)) return { ok: false, reasons: ['invalid_loan_settlement'] };
      settlementCash = net.sub(loan).toFixed();
    }
    return { ok: true, value: { quantityKg: quantity.toFixed(), netCropPrice: converted.amount,
      settlementCash, cropConsideration: consideration.toFixed(), originalCurrency: facts.currency.value!, referenceCurrency,
      fx: converted.fixing } };
  } catch { return { ok: false, reasons: ['invalid_decimal_or_date'] }; }
}
export function roundForPublication(value: string, resolution = '50'): string {
  return new Decimal(value).div(resolution).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(resolution).toFixed();
}
export function offerDeltaPct(offer: string, median: string): string {
  const value = new Decimal(median);
  if (value.lte(0)) throw new Error('Median must be positive');
  return new Decimal(offer).sub(value).div(value).mul(100).toFixed();
}
/** Minimal evidence-centric money normalization: optional quality facts never gate arithmetic. */
export function normalizeMoneyBasis(money: MoneyBasis, date: string, referenceCurrency: string, rates: FxRate[]):
  { ok: true; value: { netCropPrice: string; settlementCash: string | null; cropConsideration: string | null; fx: FxRate | null } } | { ok: false; reasons: string[] } {
  if (!moneyBasisSchema.safeParse(money).success) return { ok: false, reasons: ['invalid_money_basis'] };
  if (money.status !== 'confirmed') return { ok: false, reasons: ['unconfirmed_money'] };
  if (money.cropCharges === undefined) return { ok: false, reasons: ['unknown_crop_charges'] };
  const amount = new Decimal(money.amount); const charges = new Decimal(money.cropCharges);
  if (amount.lte(0) || charges.lt(0)) return { ok: false, reasons: ['invalid_amount_or_charges'] };
  const quantity = money.quantityKg === undefined ? null : new Decimal(money.quantityKg);
  if (quantity?.lte(0)) return { ok: false, reasons: ['invalid_quantity'] };
  if (money.sourceQuantity !== undefined && new Decimal(money.sourceQuantity).lte(0)) return { ok: false, reasons: ['invalid_source_quantity'] };
  if (!quantity && (money.basis === 'lot' || charges.gt(0))) return { ok: false, reasons: ['quantity_required'] };
  if (quantity && money.sourceQuantity !== undefined && money.sourceUnit !== undefined && money.sourceUnit !== 'sack') {
    const factor = { kg: '1', tonne: '1000', lb: '0.45359237' }[money.sourceUnit];
    if (!factor) return { ok: false, reasons: ['unsupported_unit'] };
    if (!new Decimal(money.sourceQuantity).mul(factor).eq(quantity)) return { ok: false, reasons: ['quantity_unit_conflict'] };
  }
  const gross = quantity ? (money.basis === 'per_kg' ? amount.mul(quantity) : amount) : null;
  if (gross && charges.gte(gross)) return { ok: false, reasons: ['charges_exceed_consideration'] };
  const netPrice = money.basis === 'per_kg' ? amount.sub(quantity ? charges.div(quantity) : 0) : amount.sub(charges).div(quantity!);
  const conversion = convertCurrency(netPrice.toFixed(), money.currency, referenceCurrency, date, rates);
  if (!conversion.ok) return conversion;
  if (money.loanSettlement !== undefined && new Decimal(money.loanSettlement).lt(0)) return { ok: false, reasons: ['invalid_loan_settlement'] };
  return { ok: true, value: { netCropPrice: conversion.amount, cropConsideration: gross?.toFixed() ?? null,
    settlementCash: gross && money.loanSettlement !== undefined ? gross.sub(charges).sub(money.loanSettlement).toFixed() : null, fx: conversion.fixing } };
}
