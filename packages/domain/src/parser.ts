import Decimal from 'decimal.js';
import { emptySaleFacts, fact, type ParsedInput, type SaleFacts, type SaleFactKey } from './contracts.js';
import type { MoneyBasis, Observation } from './learned-contracts.js';

export const PREPROCESSING_VERSION = 'evidence-text-v4';
const numericSource = String.raw`\d+(?:[ ,.]\d{3})*(?:[.,]\d{1,2})?`;
const signedNumericSource = String.raw`(?:[+\-\u2212]\s*)?${numericSource}`;
const currencySource = String.raw`TZS|USD|INR|KES|EUR|GBP|\$|TSh(?:s)?|Tanzanian\s+shillings?|Kenyan\s+shillings?|shillings?`;
const moneyPattern = () => new RegExp(String.raw`(?:(${currencySource})\s*(${signedNumericSource})|(${signedNumericSource})\s*(${currencySource}))`, 'gi');
const financialLabelSource = String.raw`buyer\s+offers?|offered|offer(?:\s+amount)?|asking\s+price|unit\s+(?:quote|price)|crop\s+consideration|price|prix|offre|bei|sale\s+costs?|charges?|costs?|deductions?|frais(?:\s+de\s+vente)?|gharama\s+za\s+mauzo|makato|loan(?:\s+(?:repayment|settlement))?|debt|remboursement\s+(?:du\s+)?pr[eê]t|malipo\s+ya\s+deni|mkopo`;
const financialAmountPattern = () => new RegExp(String.raw`\b(?:${financialLabelSource})\s*(?:are|is|sont|est|ni|[:=])?\s*(?:(?:${currencySource})\s*)?${signedNumericSource}(?:\s*(?:${currencySource}))?(?:\s*(?:\/\s*kg|per\s+(?:kg|kilogram)|par\s+(?:kg|kilo)|kwa\s+kilo))?`, 'gi');
export function parseDecimalNotation(value: string): string {
  const compact = value.replace(/\s/g, '').replace('\u2212', '-');
  const sign = compact.startsWith('-') ? '-' : '';
  let clean = compact.replace(/^[+-]/, '');
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(clean)) clean = clean.replace(/,/g, '');
  else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(clean)) clean = clean.replace(/\./g, '').replace(',', '.');
  else clean = clean.replace(',', '.');
  return new Decimal(`${sign}${clean}`).toFixed();
}
function currencyCode(value: string): string | null {
  const upper = value.toUpperCase();
  if (/^SHILLING/.test(upper)) return null;
  return upper === '$' ? 'USD' : /^(TSH|TANZANIAN)/.test(upper) ? 'TZS' : /^KENYAN/.test(upper) ? 'KES' : upper;
}
function financialClause(prefix: string): 'charges' | 'loan' | null {
  if (/(?:\b(?:loan(?:\s+(?:settlement|repayment))?|debt|mkopo)|remboursement\s+(?:du\s+)?pr[eê]t|malipo\s+ya\s+deni)\s*(?:is|are|est|sont|ni|[:=])?\s*$/i.test(prefix)) return 'loan';
  if (/(?:\b(?:(?:sale\s+)?(?:charges?|costs?|deductions?)|frais(?:\s+de\s+vente)?|makato)|gharama\s+za\s+mauzo)\s*(?:is|are|est|sont|ni|[:=])?\s*$/i.test(prefix)) return 'charges';
  return null;
}
/** Only guard explicit negation next to a supported term; this is not a general language model. */
function hasNegatedMention(text: string, pattern: RegExp): boolean {
  const negationPrefix = /\b(?:not|no|never|pas|si|sio|kein|nicht)\b(?:\s+(?:actually|be|being|sold|as|in|the|a|an|du|de|d['\u2019]|coffee|caf[eé]|kahawa))*\s*$/i;
  for (const match of text.matchAll(new RegExp(pattern.source, 'gi'))) {
    const prefix = text.slice(0, match.index).split(/[.;!?\n,]/).at(-1) ?? '';
    if (negationPrefix.test(prefix) || /\bnon[-\s]*$/i.test(prefix)) return true;
  }
  return false;
}
/** Shared input preparation never infers a quality category from a price or a name. */
export function preprocessDescription(text: string): { description: string; chunks: string[]; issues: string[]; version: string } {
  const issues: string[] = [];
  let description = text.normalize('NFKC');
  // Strip labeled finance amounts before the generic currency scan. Bare charges and debt
  // amounts often inherit the receipt currency; retaining their numerals would leak price
  // components into the similarity representation even though the main offer was removed.
  description = description.replace(financialAmountPattern(), ' ')
    .replace(/\b(?:no\s+(?:charges?|costs?|deductions?|loan|debt)|sans\s+(?:frais|pr[eê]t|dette)|hakuna\s+makato)\b/gi, ' ');
  description = description.replace(moneyPattern(), ' ');
  // Unit-price notation without a currency is consequential and must be clarified.
  if (new RegExp(String.raw`${signedNumericSource}\s*(?:\/\s*kg|per\s+kg|par\s+kg)`, 'i').test(description)) {
    issues.push('currency_missing');
    description = description.replace(new RegExp(String.raw`${signedNumericSource}\s*(?:\/\s*kg|per\s+kg|par\s+kg)`, 'gi'), ' ');
  }
  description = description.replace(/\b(?:buyer|seller|farmer|contributor)\s*(?:name|id)\s*[:=]\s*[^,;.\n]+/gi, ' ')
    .replace(/\b(?:receipt|invoice|transaction)\s*(?:number|no\.?|id)\s*[:#=]\s*\S+/gi, ' ')
    .replace(/\b(?:buyer\s+offers?|offered|offer(?:\s+amount)?|asking\s+price|price|prix|offre|bei)\s*[:=]?\s*(?:per\s+kg|par\s+kg|\/kg)?\s*(?=[.;,]|$)/gi, ' ')
    .replace(/\s+(?:\/\s*kg|per\s+kg|par\s+kg)(?=\s*[.;,]|$)/gi, ' ');
  const sentences = description.split(/(?<=[.!?;])\s+|\n+/).map(sentence => sentence.trim().replace(/\s+/g, ' '))
    .filter(sentence => /\p{L}/u.test(sentence) && !/^(?:(?:and|et|na|the|les|le|la|de|du)\b|[\s.,;:])+$/i.test(sentence));
  const seen = new Set<string>(); const unique: string[] = [];
  for (const sentence of sentences) {
    const key = sentence.toLowerCase().replace(/[.!?;]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key); unique.push(sentence);
  }
  description = unique.join(' ').trim();
  const chunks: string[] = []; let current: string[] = [];
  for (const sentence of unique) {
    const words = sentence.split(/\s+/);
    if (words.length > 120) {
      issues.push('long_sentence_split');
      if (current.length) { chunks.push(current.join(' ')); current = []; }
      for (let start = 0; start < words.length; start += 120) chunks.push(words.slice(start, start + 120).join(' '));
    } else if (current.length + words.length > 120) { chunks.push(current.join(' ')); current = words; }
    else current.push(...words);
  }
  if (current.length) chunks.push(current.join(' '));
  if (!description || !/[\p{L}]/u.test(description)) issues.push('description_missing');
  return { description, chunks, issues: [...new Set(issues)], version: PREPROCESSING_VERSION };
}
export type ParserOptions = {
  language?: string; offerDate?: string;
  context?: { cropId?: string; marketAreaId?: string; saleChannel?: string; deliveryTerms?: string; paymentTerms?: string };
};
export function parseExactFacts(text: string, options: ParserOptions = {}): ParsedInput {
  const facts = emptySaleFacts(); const clarifications: ParsedInput['clarifications'] = [];
  const refs = ['input:text'];
  const put = <K extends SaleFactKey>(field: K, value: NonNullable<SaleFacts[K]['value']>) => {
    // All fields share fact metadata; enum-specific values are checked by the shared schema on submission.
    (facts[field] as { value: unknown; status: string; sourceRefs: string[] }) = { value, status: 'extracted', sourceRefs: refs };
  };
  const ask = (field: SaleFactKey | 'description', reason: string, question: string) => clarifications.push({ field, reason, question });
  for (const [field, value] of Object.entries(options.context ?? {})) {
    if (value) (facts[field as SaleFactKey] as { value: unknown; status: string; sourceRefs: string[] }) = { value, status: 'confirmed', sourceRefs: ['session:selected-context'] };
  }
  if (options.offerDate) facts.saleDate = fact(options.offerDate, 'confirmed', ['session:offer-date']);
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (date) put('saleDate', date[0]);
  if (/\b(?:coffee|caf[eé]|kahawa|kaffee)\b/i.test(text)) put('cropId', 'coffee');
  const putCriticalTerm = (field: 'species' | 'deliveryTerms' | 'paymentTerms', terms: readonly (readonly [string, RegExp])[],
    question: string, extraNegation?: RegExp) => {
    const found = terms.filter(([, pattern]) => pattern.test(text));
    const negated = found.some(([, pattern]) => hasNegatedMention(text, pattern)) || Boolean(extraNegation?.test(text));
    if (found.length === 1 && !negated) put(field, found[0]![0]);
    else if (found.length || negated) {
      facts[field] = fact(null);
      ask(field, `conflicting_or_negated_${field}`, question);
    }
  };
  putCriticalTerm('species', [['arabica', /\barabi[ck]a\b/i], ['robusta', /\brobusta\b/i]], 'Which coffee species is actually being sold?');
  const forms = [ ['parchment', /\b(?:parchment|parche|pergamino|pergament)\b/i],
    ['cherry', /\b(?:cherry|cherries|cerises?|matunda)\b/i], ['green', /\b(?:green\s+(?:coffee|beans?)|caf[eé]\s+vert|kahawa\s+ya\s+kijani)\b/i] ] as const;
  const foundForms = forms.filter(([, regex]) => regex.test(text));
  if (foundForms.length === 1 && !foundForms.some(([, pattern]) => hasNegatedMention(text, pattern))) put('productForm', foundForms[0]![0]);
  else if (foundForms.length) ask('productForm', 'conflicting_or_negated_form', 'Which processing form is actually being sold?');
  if (/\b(?:unsorted|not\s+(?:hand\s+)?sorted|mixed|non\s+tri[eé]|m[eé]lang[eé]|haijachambuliwa)\b/i.test(text)) put('sorting', 'mixed');
  else if (/\b(?:hand\s*sorted|sorted|tri[eé]|chambuliwa|sortiert)\b/i.test(text)) put('sorting', 'sorted');
  putCriticalTerm('deliveryTerms', [
    ['buyer_collects', /\b(?:buyer\s+(?:collects|will\s+collect|picks?\s+(?:it\s+)?up|comes?\s+to\s+(?:the\s+|my\s+)?farm)|collected\s+(?:at|from)\s+(?:the\s+|my\s+)?farm|acheteur\s+(?:r[eé]cup[eè]re|collecte|vient\s+chercher)|mnunuzi\s+(?:anachukua|atachukua|anakuja))\b/i],
    ['seller_delivers', /\b(?:seller\s+delivers|deliver(?:ed|y)?\s+to\s+buyer|livr[eé]\s+par\s+le\s+vendeur)\b/i],
  ], 'Who is responsible for collecting or delivering the crop?',
  /\b(?:buyer\s+(?:does\s+not|doesn't|never)\s+(?:collect|pick\s+up)|seller\s+(?:does\s+not|doesn't|never)\s+deliver)\b/i);
  putCriticalTerm('paymentTerms', [
    ['immediate', /(?:\bimmediate(?:ly)?\s+(?:cash|payment)|\b(?:paid|pays?|paying|will\s+pay)\s+(?:me\s+)?(?:(?:in\s+)?cash\s+)?(?:today|immediately|now|right\s+away|on\s+the\s+spot|on\s+collection|on\s+pickup)|\bcash\s+(?:today|now|on\s+the\s+spot|on\s+collection|on\s+pickup)|\bpaiement\s+imm[eé]diat|\bpai(?:e|era)\s+(?:imm[eé]diatement|tout\s+de\s+suite|comptant)|\bmalipo\s+ya\s+papo\s+hapo|\b(?:a|ana|ata)lipa\s+(?:papo\s+hapo|mara\s+moja|leo))\b/i],
    ['deferred', /\b(?:deferred|(?:paid|pays?|paying|will\s+pay)\s+(?:me\s+)?(?:later|next\s+(?:week|month)|after\s+(?:resale|delivery))|pay(?:s|ment)?\s+(?:in|after)\s+\d+\s+(?:days|weeks)|paiement\s+diff[eé]r[eé]|paiera\s+plus\s+tard|malipo\s+baadaye|(?:a|ana|ata)lipa\s+baadaye)\b/i],
  ], 'Is payment immediate or deferred?',
  /\b(?:paid\s+(?:not|never)\s+(?:today|immediately)|(?:payment|cash)\s+(?:is\s+)?not\s+(?:immediate|today)|(?:does\s+not|doesn't)\s+pay\s+(?:today|immediately))\b/i);
  if (/\b(?:farmgate|farm\s+gate|at\s+(?:the\s+|my\s+)?farm|[àa]\s+la\s+ferme|shambani)\b/i.test(text)) put('saleChannel', 'farmgate');
  const moneyMatches = [...text.matchAll(moneyPattern())];
  const offerMatches = moneyMatches.filter(match => financialClause(text.slice(Math.max(0, match.index! - 65), match.index!)) === null);
  if (offerMatches.some(match => currencyCode(match[1] ?? match[4]!) === null)) ask('currency', 'ambiguous_shillings', 'Which shilling currency is meant: TZS, KES, or another currency?');
  const amounts = [...new Set(offerMatches.flatMap(match => {
    const code = currencyCode(match[1] ?? match[4]!);
    return code ? [`${code}:${parseDecimalNotation(match[2] ?? match[3]!)}`] : [];
  }))];
  if (amounts.length === 1) {
    const [currency, amount] = amounts[0]!.split(':'); put('currency', currency!);
    const match = offerMatches[0]!;
    const unitPrice = /^(?:\s*(?:\/\s*kg|per\s+(?:kg|kilogram)|par\s+(?:kg|kilo)|kwa\s+kilo))/i.test(text.slice(match.index! + match[0].length));
    put('priceBasis', unitPrice ? 'per_kg' : 'lot'); put(unitPrice ? 'quotedUnitPrice' : 'cropConsideration', amount!);
  } else if (amounts.length > 1) ask('cropConsideration', 'conflicting_amounts', 'Which amount is the crop offer, before loans and charges?');
  const mixedCurrencyFields = new Set<SaleFactKey>();
  const financingValues = { saleCosts: new Set<string>(), loanSettlement: new Set<string>() };
  for (const match of moneyMatches) {
    const prefix = text.slice(Math.max(0, match.index! - 65), match.index!);
    const amount = parseDecimalNotation(match[2] ?? match[3]!);
    const kind = financialClause(prefix);
    const field = kind === 'loan' ? 'loanSettlement' : kind === 'charges' ? 'saleCosts' : null;
    const code = currencyCode(match[1] ?? match[4]!);
    if (field && (!code || (facts.currency.value !== null && code !== facts.currency.value))) {
      mixedCurrencyFields.add(field); ask(field, 'mixed_financial_currencies', 'Confirm this charge or loan amount in the same currency as the crop offer.');
    } else if (field) financingValues[field].add(amount);
  }
  for (const [field, pattern] of [
    ['saleCosts', String.raw`(?:sale\s+costs?|charges?|deductions?|frais\s+de\s+vente|frais|gharama\s+za\s+mauzo|makato)\s*(?:are|is|sont|est|ni|[:=])?\s*(?:${currencySource})?\s*(${signedNumericSource})`],
    ['loanSettlement', String.raw`(?:loan\s+(?:repayment|settlement)|loan|debt|remboursement\s+(?:du\s+)?pr[eê]t|malipo\s+ya\s+deni|mkopo)\s*(?:are|is|sont|est|ni|[:=])?\s*(?:${currencySource})?\s*(${signedNumericSource})`],
  ] as const) {
    for (const match of text.matchAll(new RegExp(pattern, 'gi'))) financingValues[field].add(parseDecimalNotation(match[1]!));
  }
  // A zero declaration is evidence too: it must not overwrite a contradictory amount.
  if (/\b(?:no\s+(?:charges?|costs?|deductions?)|sans\s+frais|hakuna\s+makato)\b/i.test(text)) financingValues.saleCosts.add('0');
  if (/\b(?:no\s+(?:loan|debt)|sans\s+(?:pr[eê]t|dette))\b/i.test(text)) financingValues.loanSettlement.add('0');
  for (const field of ['saleCosts', 'loanSettlement'] as const) {
    const values = [...financingValues[field]];
    if (mixedCurrencyFields.has(field)) facts[field] = fact(null);
    else if (values.length === 1) put(field, values[0]!);
    else if (values.length > 1) { facts[field] = fact(null); ask(field, 'conflicting_financing_amounts', 'Which charge or financing amount is correct?'); }
  }
  const forwardQuantities = [...text.matchAll(new RegExp(String.raw`(${numericSource})\s*(kg|kilograms?|kilos?|kilogrammes?|tonnes?|tons?|lbs?|pounds?|sacks?|bags?|sacs?|magunia)\b`, 'gi'))];
  const reverseQuantities = [...text.matchAll(new RegExp(String.raw`\b(kilo|kilogramu)\s+(${numericSource})`, 'gi'))]
    .map(match => ({ 0: match[0], 1: match[2]!, 2: match[1]!, index: match.index }));
  const quantities = [...forwardQuantities, ...reverseQuantities]
    .filter(match => !moneyMatches.some(money => match.index! >= money.index! && match.index! < money.index! + money[0].length));
  if (quantities.length === 1) {
    const match = quantities[0]!; const quantity = parseDecimalNotation(match[1]!); const unit = match[2]!.toLowerCase();
    const sourceUnit = /^(kg|kilo)/.test(unit) ? 'kg' : /^(ton)/.test(unit) ? 'tonne' : /^(lb|pound)/.test(unit) ? 'lb' : 'sack';
    put('sourceQuantity', quantity); put('sourceUnit', sourceUnit);
    if (sourceUnit !== 'sack') put('quantityKg', new Decimal(quantity).mul({ kg: '1', tonne: '1000', lb: '0.45359237' }[sourceUnit]!).toFixed());
    else ask('quantityKg', 'unknown_sack_mass', 'What is the total measured weight in kilograms?');
  } else if (quantities.length > 1) ask('quantityKg', 'multiple_quantities', 'What is the confirmed total sale weight in kilograms?');
  const prepared = preprocessDescription(text);
  for (const issue of prepared.issues.filter(value => value !== 'long_sentence_split')) ask('description', issue, 'Describe the crop and sale terms without the price or names.');
  return { facts, clarifications, priceFreeNarrative: prepared.description, language: options.language ?? 'en' };
}
export function observationsFromDescription(description: string): Observation[] {
  return preprocessDescription(description).chunks.map((statement, index) => ({ id: `input-observation-${index}`, statement,
    polarity: 'uncertain', status: 'reported', sourceRefs: ['input:text'] }));
}
export function moneyBasisFromFacts(facts: SaleFacts): MoneyBasis | undefined {
  const amount = facts.priceBasis.value === 'per_kg' ? facts.quotedUnitPrice.value : facts.cropConsideration.value;
  if (!amount || !facts.currency.value || !facts.priceBasis.value) return undefined;
  const fields = [facts.priceBasis, facts.currency, facts.priceBasis.value === 'per_kg' ? facts.quotedUnitPrice : facts.cropConsideration, facts.saleCosts];
  const isConfirmed = (field: { value: unknown; status: string }) => field.value !== null && ['confirmed', 'attested'].includes(field.status);
  const quantityRequired = facts.priceBasis.value === 'lot' || (facts.saleCosts.value !== null && new Decimal(facts.saleCosts.value).gt(0));
  if (quantityRequired) fields.push(facts.quantityKg);
  // A confirmed unit price can stand on its own. Optional extracted weight or debt
  // must not manufacture a confirmed gross consideration or settlement cash total.
  const includeQuantity = quantityRequired || isConfirmed(facts.quantityKg);
  return { amount, currency: facts.currency.value, basis: facts.priceBasis.value,
    ...(includeQuantity && facts.quantityKg.value !== null ? { quantityKg: facts.quantityKg.value } : {}),
    ...(includeQuantity && facts.sourceQuantity.value !== null ? { sourceQuantity: facts.sourceQuantity.value } : {}),
    ...(includeQuantity && facts.sourceUnit.value !== null ? { sourceUnit: facts.sourceUnit.value } : {}),
    ...(facts.saleCosts.value !== null ? { cropCharges: facts.saleCosts.value } : {}),
    ...(isConfirmed(facts.loanSettlement) ? { loanSettlement: facts.loanSettlement.value! } : {}),
    status: fields.every(isConfirmed) ? 'confirmed' : 'proposed', sourceRefs: ['input:text'] };
}
