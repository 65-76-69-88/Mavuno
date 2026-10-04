import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { addDays, capContributorWeights, comparisonPackSchema, countBand, daysBetween,
  deduplicateTransactions, effectiveSampleSize, evidenceScore, normalizeSale, packManifestSchema,
  reputationFromReviews, COFFEE_PROFILE, POLICY_VERSION, evidenceRecordScore, assessEvidenceRecordEligibility } from '@pricemesh/domain';
import type { ComparisonPack, EvidenceRecord, FxRate, PackManifest, PrivateTransaction, WeightedPrice } from '@pricemesh/domain';

const vectorSchema=z.array(z.number().finite()).length(384);
const topicSchema=z.object({id:z.string(),label:z.string(),description:z.string(),
  reviewStatus:z.enum(['reviewed','synthetic_unreviewed'])}).strict();
export const learnedModelSchema=z.object({
  encoderVersion:z.string(),preprocessingVersion:z.string(),adapterVersion:z.string(),
  trainingStatus:z.enum(['accepted','baseline']),calibrationVersion:z.string(),
  adapter:vectorSchema,
  calibration:z.object({status:z.enum(['pending','passed','failed']),minSimilarity:z.number(),minMargin:z.number(),
    kernelTemperature:z.number().positive(),maxDistance:z.number().positive()}).strict(),
  groups:z.array(z.object({id:z.string(),centroid:vectorSchema,radius:z.number().positive(),topics:z.array(topicSchema),
    context:z.object({species:z.string().optional(),productForm:z.string().optional(),deliveryTerms:z.string().optional(),
      paymentTerms:z.string().optional()}).strict(),memberIds:z.array(z.string())}).strict()),
}).strict();
export type LearnedModel=z.infer<typeof learnedModelSchema>;
export type Membership={reportId:string;included:boolean;reason:string};
export type HistogramAudit={originalMaximumContributorShare:number;representedMaximumContributorShare:number;
  initialIntervalCount:number;finalIntervalCount:number;roundingMerges:number};
export type PackBuild={manifest:PackManifest;pack:ComparisonPack;files:Map<string,Buffer>;memberships:Membership[];
  diagnostics:{suppressed:{groupId:string;reasons:string[]}[];includedLots:number;publishedGroups:number;decodedBytes:number;
    histogramAudits:({groupId:string}&HistogramAudit)[]}};
type SourceRecord=PrivateTransaction & {evidenceRecord?:EvidenceRecord};
export type PackBuildOptions={transactions:SourceRecord[];fxRates:FxRate[];asOf:string;packVersion:string;
  model:LearnedModel;additionalAssignments?:Map<string,string>;representations?:Map<string,number[]>;publishedAt?:string};

/** All vectors are learned aggregate centroids; individual embeddings never enter the public pack. */
export function float32Bytes(vectors:number[][]):Buffer {
  const output=Buffer.alloc(vectors.length*384*4);
  vectors.forEach((vector,row)=>vector.forEach((value,column)=>output.writeFloatLE(value,(row*384+column)*4)));
  return output;
}

export function normalizeVector(vector:number[]):number[] {
  if (vector.length!==384 || vector.some(value=>!Number.isFinite(value))) throw new Error('Invalid encoder vector.');
  const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));
  if (!(norm>0)) throw new Error('Encoder vector has no magnitude.');
  return vector.map(value=>value/norm);
}
export function applyAdapter(vector:number[],adapter:number[]):number[] {
  if (adapter.length!==384 || adapter.some(value=>!(value>0) || !Number.isFinite(value))) throw new Error('Invalid adapter scales.');
  return normalizeVector(vector.map((value,index)=>value*adapter[index]!));
}
export function knownContextContradictions(record:PrivateTransaction,context:LearnedModel['groups'][number]['context']):string[] {
  const reasons:string[]=[];
  for (const key of ['species','productForm','deliveryTerms','paymentTerms'] as const) {
    const expected=context[key]; const received=record.facts[key].value;
    if (expected && received && expected!==received) reasons.push(`incompatible_${key}`);
  }
  return reasons;
}
export function assignToLearnedGroup(record:PrivateTransaction,rawVector:number[],model:LearnedModel):string|null {
  const vector=applyAdapter(rawVector,model.adapter);
  const candidates=model.groups.filter(group=>knownContextContradictions(record,group.context).length===0)
    .map(group=>({group,distance:Math.sqrt(vector.reduce((sum,value,index)=>sum+(value-group.centroid[index]!)**2,0))}))
    .sort((left,right)=>left.distance-right.distance);
  const first=candidates[0];
  if (!first || first.distance>model.calibration.maxDistance) return null;
  return first.group.id;
}

function validReference(record:SourceRecord,asOf:string,rates:FxRate[]):{price:string|null;reasons:string[]} {
  if(record.evidenceRecord) {
    const assessment=assessEvidenceRecordEligibility(record.evidenceRecord,{cropId:'coffee',regionId:'ondera-demo',marketTier:'farmgate',referenceCurrency:'TZS'},asOf,rates);
    if(!record.synthetic) assessment.reasons.push('real_records_not_supported_by_demo');
    return {price:assessment.netCropPrice,reasons:assessment.reasons};
  }
  const reasons:string[]=[];
  if (!record.synthetic) reasons.push('real_records_not_supported_by_demo');
  if (!record.consent.aggregateUse) reasons.push('aggregate_consent_required');
  if (record.reviewState!=='approved') reasons.push(`review_${record.reviewState}`);
  if (record.facts.cropId.value!=='coffee') reasons.push('incompatible_crop');
  if (record.facts.marketAreaId.value!=='ondera-demo') reasons.push('incompatible_market');
  if (record.facts.saleChannel.value!=='farmgate') reasons.push('incompatible_market_tier');
  const date=record.facts.saleDate.value;
  if (!date) reasons.push('sale_date_required');
  else {const age=daysBetween(date,asOf);if(age<0 || age>90) reasons.push('sale_outside_observation_window');}
  const normalized=normalizeSale(record.facts,'TZS',rates);
  if (!normalized.ok) reasons.push(...normalized.reasons);
  return {price:normalized.ok?normalized.value.netCropPrice:null,reasons};
}

export function sourceEvidenceScore(record:SourceRecord):ReturnType<typeof evidenceScore> {
  return record.evidenceRecord?evidenceRecordScore(record.evidenceRecord):evidenceScore(record);
}

type PrivateInterval={start:number;end:number;mass:number;contributorMasses:Map<string,number>};
function mergeIntervals(left:PrivateInterval,right:PrivateInterval):PrivateInterval {
  const contributorMasses=new Map(left.contributorMasses);
  for(const [id,mass] of right.contributorMasses) contributorMasses.set(id,(contributorMasses.get(id)??0)+mass);
  return {start:left.start,end:right.end,mass:left.mass+right.mass,contributorMasses};
}
function roundedIntervalMasses(intervals:PrivateInterval[]):number[] {
  const rounded=intervals.map(interval=>Math.round(interval.mass*20)/20);
  const total=rounded.reduce((sum,mass)=>sum+mass,0);
  if(!(total>0)) throw new Error('Histogram has no represented mass after rounding.');
  return rounded.map(mass=>mass/total);
}
function maximumRepresentedShare(intervals:PrivateInterval[],roundedMasses:number[]):number {
  const shares=new Map<string,number>();
  intervals.forEach((interval,index)=> {
    if(interval.mass<=0) return;
    for(const [id,mass] of interval.contributorMasses) shares.set(id,(shares.get(id)??0)+roundedMasses[index]!*mass/interval.mass);
  });
  return Math.max(0,...shares.values());
}
export class HistogramCapError extends Error {}

/** Private rounding audit prevents a coarse public distribution from undoing contributor caps. */
export function buildCoarseDistribution(records:WeightedPrice[],binWidth='250',cap=.25):{
  distribution:{lower:string;upper:string;mass:number}[];audit:HistogramAudit;
} {
  const totalWeight=records.reduce((sum,record)=>sum+record.weight,0);
  if(!(totalWeight>0) || records.some(record=>!Number.isFinite(record.weight) || record.weight<0)) throw new Error('Invalid histogram source weights.');
  const width=new Decimal(binWidth); const bins=new Map<number,PrivateInterval>();
  const contributorShares=new Map<string,number>();
  for (const record of records) {
    if(record.weight===0) continue;
    const price=new Decimal(record.price);
    if(price.lt(0) || price.gt(20000)) throw new Error('Price falls outside the declared histogram grid.');
    const cell=Math.min(79,price.div(width).floor().toNumber());
    const weight=record.weight/totalWeight;
    const bin=bins.get(cell)??{start:cell,end:cell+1,mass:0,contributorMasses:new Map<string,number>()};
    bin.mass+=weight;bin.contributorMasses.set(record.contributorId,(bin.contributorMasses.get(record.contributorId)??0)+weight);bins.set(cell,bin);
    contributorShares.set(record.contributorId,(contributorShares.get(record.contributorId)??0)+weight);
  }
  const originalMaximumContributorShare=Math.max(0,...contributorShares.values());
  if(originalMaximumContributorShare>cap+1e-10) throw new HistogramCapError('Original contributor influence already exceeds the publication cap.');
  let merged:PrivateInterval[]=[];
  let pending:PrivateInterval|undefined;
  for(const [cell,bin] of [...bins].sort(([left],[right])=>left-right)) {
    pending=pending?mergeIntervals(pending,bin):bin;
    pending.end=cell+1;
    if(pending.contributorMasses.size>=3 && pending.mass>=0.025) {merged.push(pending);pending=undefined;}
  }
  if(pending) {
    const previous=merged.at(-1);
    if(previous) merged[merged.length-1]=mergeIntervals(previous,pending);
    else if(pending.contributorMasses.size>=3) merged.push(pending);
    else throw new Error('Histogram has insufficient contributor diversity.');
  }
  const initialIntervalCount=merged.length;
  let roundedMasses=roundedIntervalMasses(merged);
  let representedMaximumContributorShare=maximumRepresentedShare(merged,roundedMasses);
  while(representedMaximumContributorShare>cap+1e-10 && merged.length>1) {
    // Deterministic adjacent merge: lowest remaining cap violation, then narrowest merged interval.
    const candidates=merged.slice(0,-1).map((interval,index)=> {
      const replacement=mergeIntervals(interval,merged[index+1]!);
      const intervals=[...merged.slice(0,index),replacement,...merged.slice(index+2)];
      const masses=roundedIntervalMasses(intervals);
      return {intervals,masses,maximum:maximumRepresentedShare(intervals,masses),width:replacement.end-replacement.start,index};
    }).sort((left,right)=>left.maximum-right.maximum || left.width-right.width || left.index-right.index);
    const chosen=candidates[0]!;
    merged=chosen.intervals;roundedMasses=chosen.masses;representedMaximumContributorShare=chosen.maximum;
  }
  if(representedMaximumContributorShare>cap+1e-10) throw new HistogramCapError('Contributor influence exceeds the cap after histogram rounding.');
  return {distribution:merged.map((interval,index)=>({lower:width.mul(interval.start).toFixed(),upper:width.mul(interval.end).toFixed(),mass:roundedMasses[index]!})),
    audit:{originalMaximumContributorShare,representedMaximumContributorShare,initialIntervalCount,finalIntervalCount:merged.length,
      roundingMerges:initialIntervalCount-merged.length}};
}

/** Public output contains only intervals and masses, never the private contributor audit inputs. */
export function coarseDistribution(records:WeightedPrice[],binWidth='250'):{lower:string;upper:string;mass:number}[] {
  return buildCoarseDistribution(records,binWidth).distribution;
}

export function buildComparisonPack(options:PackBuildOptions):PackBuild {
  const model=learnedModelSchema.parse(options.model);
  if (new Set(model.groups.map(group=>group.id)).size!==model.groups.length) throw new Error('Duplicate group ID.');
  const {unique,duplicates}=deduplicateTransactions(options.transactions);
  const reasons=new Map<string,string>(duplicates.map(record=>[record.id,'duplicate_lot_or_report']));
  const recordsById=new Map(unique.map(record=>[record.id,record]));
  const groupMemberships=new Map<string,string>();
  for (const group of model.groups) for (const id of group.memberIds) {
    if (groupMemberships.has(id)) throw new Error('One source report belongs to multiple groups.');
    groupMemberships.set(id,group.id);
  }
  for (const [id,groupId] of options.additionalAssignments??[]) groupMemberships.set(id,groupId);
  const publishedGroups:ComparisonPack['groups']=[];
  const publishedCentroids:number[][]=[];
  const publishedBaseMasses:number[]=[];
  const suppressed:PackBuild['diagnostics']['suppressed']=[];
  const histogramAudits:PackBuild['diagnostics']['histogramAudits']=[];
  const included=new Set<string>();
  const policy=COFFEE_PROFILE.publication;
  for (const group of model.groups) {
    const eligible:PrivateTransaction[]=[]; const prices:Omit<WeightedPrice,'weight'>[]=[];
    for (const [id,groupId] of groupMemberships) {
      if (groupId!==group.id) continue;
      const record=recordsById.get(id); if(!record) continue;
      const valid=validReference(record,options.asOf,options.fxRates);
      valid.reasons.push(...knownContextContradictions(record,group.context));
      if(valid.reasons.length || valid.price===null) {reasons.set(id,[...new Set(valid.reasons)].join(', '));continue;}
      const preliminaryWeight=sourceEvidenceScore(record).score/100*reputationFromReviews(unique,record.contributorId).score
        *2**(-daysBetween(record.facts.saleDate.value!,options.asOf)/30);
      if (!(preliminaryWeight>0)) {reasons.set(id,'zero_evidence_weight');continue;}
      eligible.push(record);prices.push({id,contributorId:record.contributorId,price:valid.price,preliminaryWeight});
    }
    const contributors=new Set(eligible.map(record=>record.contributorId));
    const groupReasons:string[]=[];
    if (eligible.length<policy.minimumLots) groupReasons.push('too_few_lots');
    if (contributors.size<policy.minimumContributors) groupReasons.push('too_few_contributors');
    const weights=contributors.size>=policy.minimumContributors?capContributorWeights(prices,policy.contributorCap):[];
    const shares=new Map<string,number>();
    for(const weighted of weights) shares.set(weighted.contributorId,(shares.get(weighted.contributorId)??0)+weighted.weight);
    if(effectiveSampleSize(weights.map(record=>record.weight))<policy.minimumTransactionEffectiveN) groupReasons.push('transaction_concentration');
    if(effectiveSampleSize([...shares.values()])<policy.minimumContributorEffectiveN) groupReasons.push('contributor_concentration');
    if(Math.max(0,...shares.values())>policy.contributorCap+1e-10) groupReasons.push('contributor_cap_exceeded');
    if(groupReasons.length) {
      suppressed.push({groupId:group.id,reasons:groupReasons});
      for(const record of eligible) reasons.set(record.id,'group_suppressed: '+groupReasons.join(', '));
      continue;
    }
    let vector=group.centroid;
    let radius=Math.ceil((group.radius+1e-6)*100)/100;
    if(options.representations && weights.every(record=>options.representations!.has(record.id))) {
      vector=Array.from({length:384},(_,index)=>weights.reduce((sum,record)=>sum+record.weight*options.representations!.get(record.id)![index]!,0));
      radius=Math.ceil((Math.max(...weights.map(record=>Math.sqrt(options.representations!.get(record.id)!
        .reduce((sum,value,index)=>sum+(value-vector[index]!)**2,0))))+1e-6)*100)/100;
    }
    // Centers are means of normalized transaction representations; they intentionally remain unnormalized.
    if(vector.every(value=>value===0) || vector.some(value=>!Number.isFinite(value))) throw new Error('Invalid learned center.');
    let distribution:ReturnType<typeof coarseDistribution>;
    try{const built=buildCoarseDistribution(weights, '250',policy.contributorCap);distribution=built.distribution;histogramAudits.push({groupId:group.id,...built.audit});}
    catch(error){const reason=error instanceof HistogramCapError?'histogram_contributor_cap':'unsupported_histogram_grid';
      suppressed.push({groupId:group.id,reasons:[reason]});for(const record of eligible) reasons.set(record.id,'group_suppressed: '+reason);continue;}
    publishedGroups.push({id:group.id,vector:{byteOffset:publishedCentroids.length*384*4,dimensions:384},radius,prior:0,
      distribution,countBands:{lots:countBand(eligible.length),contributors:countBand(contributors.size),
        custodians:countBand(new Set(eligible.map(record=>record.cooperativeId)).size)},topics:group.topics,context:group.context,
      limitations:['Group support and contributors are subject to declared demo minima.','Open descriptions are reported observations, not verified quality measurements.']});
    publishedCentroids.push(vector);
    publishedBaseMasses.push(prices.reduce((sum,price)=>sum+price.preliminaryWeight,0));
    for(const record of eligible) included.add(record.id);
  }
  if(!publishedGroups.length) throw new Error('No learned group meets aggregate publication minima.');
  const totalBaseMass=publishedBaseMasses.reduce((sum,mass)=>sum+mass,0);
  const roundedPriors=publishedBaseMasses.map(mass=>Math.round(mass/totalBaseMass*20)/20);
  const priorTotal=roundedPriors.reduce((sum,mass)=>sum+mass,0);
  if(priorTotal===0 || roundedPriors.some(mass=>mass===0)) throw new Error('Group prior vanished under disclosure rounding; revise group support before publication.');
  publishedGroups.forEach((group,index)=>{group.prior=roundedPriors[index]!/priorTotal;});
  const validUntil=addDays(options.asOf,policy.expiryDays);
  const pack:ComparisonPack=comparisonPackSchema.parse({schemaVersion:2,packVersion:options.packVersion,cropId:'coffee',regionId:'ondera-demo',
    asOf:options.asOf,validUntil,referenceCurrency:'TZS',referenceUnit:'kg',rounding:'50',referenceBasis:'net_crop_price_per_kg',
    scope:{marketTier:'farmgate',description:'Fictional Arabica parchment farmgate sales in Ondera-Demo.'},
    fxRates:options.fxRates,calibration:model.calibration,groups:publishedGroups,
    disclosure:{synthetic:true,limitations:['All source sales and prices are fictional.','Coarse distributions are an approximation of the private reference.',
      'Aggregation is not a formal anonymity guarantee.','Reported characteristics are not certified quality measurements.']}});
  const files=new Map<string,Buffer>([['pack.json',Buffer.from(JSON.stringify(pack))],['adapter.f32',float32Bytes([model.adapter])],
    ['prototypes.f32',float32Bytes(publishedCentroids)]]);
  const manifest:PackManifest=packManifestSchema.parse({schemaVersion:2,packVersion:options.packVersion,policyVersion:POLICY_VERSION,cropId:'coffee',regionId:'ondera-demo',
    referenceBasis:'net_crop_price_per_kg',asOf:options.asOf,validUntil,synthetic:true,
    encoderVersion:model.encoderVersion,preprocessingVersion:model.preprocessingVersion,adapterVersion:model.adapterVersion,
    dimensions:384,trainingStatus:model.trainingStatus,vectorEncoding:'float32-le',calibrationVersion:model.calibrationVersion,
    files:[...files].map(([path,bytes])=>({path,sha256:createHash('sha256').update(bytes).digest('hex'),decodedBytes:bytes.length}))});
  files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));
  const memberships=options.transactions.map(record=>({reportId:record.id,included:included.has(record.id),
    reason:included.has(record.id)?'included_in_qualified_aggregate':reasons.get(record.id)??'no_supported_learned_group'}));
  return {manifest,pack,files,memberships,diagnostics:{suppressed,includedLots:included.size,publishedGroups:publishedGroups.length,
    decodedBytes:[...files.values()].reduce((sum,bytes)=>sum+bytes.length,0),histogramAudits}};
}
