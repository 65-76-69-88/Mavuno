import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generateSyntheticCorpus } from '../../../fixtures/synthetic/corpus.js';
import { SYNTHETIC_FX } from '../../../fixtures/synthetic/generate.js';
import { buildCoarseDistribution, buildComparisonPack, coarseDistribution, type LearnedModel } from './index.js';

function model(memberIds:string[]):LearnedModel {
  return {encoderVersion:'mathematical-test-fixture',preprocessingVersion:'evidence-text-v2',adapterVersion:'test-baseline',
    trainingStatus:'baseline',calibrationVersion:'test-only',adapter:Array(384).fill(1),
    calibration:{status:'pending',minSimilarity:-1,minMargin:0,kernelTemperature:.3,maxDistance:1},
    groups:[{id:'fixture-group',centroid:[1,...Array(383).fill(0)],radius:1,topics:[],
      context:{species:'arabica',productForm:'parchment',deliveryTerms:'buyer_collects',paymentTerms:'immediate'},memberIds}]};
}
describe('Aggregate publication',()=> {
  it('merges intervals when mass rounding would push a capped contributor above 25%',()=> {
    // The second interval holds 74% original mass; rounding to 75% would inflate A's original 25% share.
    const source=[['B',5000,.1],['C',5000,.1],['D',5000,.06],['A',6000,.25],['B',6000,.07],
      ['C',6000,.07],['D',6000,.16],['E',6000,.19]].map(([contributor,price,weight],index)=>({
        id:`rounding-source-${index}`,contributorId:String(contributor),price:String(price),weight:Number(weight),preliminaryWeight:Number(weight)}));
    expect(.75*.25/.74).toBeGreaterThan(.25);
    const built=buildCoarseDistribution(source);
    expect(built.audit.originalMaximumContributorShare).toBeCloseTo(.25,12);
    expect(built.audit.initialIntervalCount).toBe(2);expect(built.audit.roundingMerges).toBe(1);
    expect(built.audit.representedMaximumContributorShare).toBeLessThanOrEqual(.25+1e-10);
    expect(built.distribution).toEqual([{lower:'5000',upper:'6250',mass:1}]);
    expect(JSON.stringify(built.distribution)).not.toContain('contributor');
  });

  it('merges sparse price bins to three contributors without clipping legitimate extremes',()=> {
    const prices=[1500,5900,5950,5975,6100,6200,14000];
    const source=prices.map((price,index)=>({id:`private-${index}`,contributorId:`contributor-${index}`,price:String(price),
      preliminaryWeight:1,weight:1/prices.length}));
    const bins=coarseDistribution(source);
    expect(bins[0]!.lower).toBe('1500');expect(Number(bins.at(-1)!.upper)).toBeGreaterThan(14000);
    expect(bins.reduce((sum,bin)=>sum+bin.mass,0)).toBeCloseTo(1,12);
    for(const bin of bins) {
      const contributors=new Set(source.filter(record=>Number(record.price)>=Number(bin.lower) && Number(record.price)<Number(bin.upper)).map(record=>record.contributorId));
      expect(contributors.size).toBeGreaterThanOrEqual(3);
    }
    expect(()=>coarseDistribution([{...source[0]!,price:'25000'}])).toThrow('outside');
  });

  it('releases hashed aggregates and model artifacts without rows, identities or individual vectors',()=> {
    const corpus=generateSyntheticCorpus();
    const members=corpus.records.filter(record=>corpus.metadata[record.id]!.split==='train' && !corpus.metadata[record.id]!.stressType).map(record=>record.id);
    const build=buildComparisonPack({transactions:corpus.records,fxRates:SYNTHETIC_FX,asOf:'2026-10-04',packVersion:'test-v1',model:model(members)});
    expect(build.manifest.schemaVersion).toBe(2);
    expect(build.diagnostics.includedLots).toBe(96);
    const publicJson=build.files.get('pack.json')!.toString();
    for(const forbidden of ['contributorId','lotId','originalText','rawText','synthetic:source','corpus-001','fictional-cooperative']) expect(publicJson).not.toContain(forbidden);
    expect(build.pack.groups).toHaveLength(1);expect(build.pack.groups[0]!.prior).toBe(1);
    for(const asset of build.manifest.files) {
      const bytes=build.files.get(asset.path)!;
      expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(asset.decodedBytes).toBe(bytes.byteLength);
    }
    const heldout=build.memberships.filter(membership=>corpus.metadata[membership.reportId]!.split!=='train');
    expect(heldout.every(membership=>!membership.included)).toBe(true);
  });

  it('suppresses thin groups and keeps weighted aggregate centroids unnormalized',()=> {
    const corpus=generateSyntheticCorpus();
    const records=corpus.records.slice(0,96);
    expect(()=>buildComparisonPack({transactions:records,fxRates:SYNTHETIC_FX,asOf:'2026-10-04',packVersion:'thin',
      model:model(records.slice(0,4).map(record=>record.id))})).toThrow('No learned group');
    const representations=new Map(records.map((record,index)=>[record.id,[.8,index%2?.6:-.6,...Array(382).fill(0)]]));
    const build=buildComparisonPack({transactions:records,fxRates:SYNTHETIC_FX,asOf:'2026-10-04',packVersion:'weighted-center',
      model:model(records.map(record=>record.id)),representations});
    const prototypes=build.files.get('prototypes.f32')!;
    expect(prototypes.readFloatLE(0)).toBeCloseTo(.8,6);
    expect(build.pack.groups[0]!.radius).toBeGreaterThanOrEqual(.6);
  });
});
