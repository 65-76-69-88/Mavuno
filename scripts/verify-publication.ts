/** Evaluate the final encoded/rounded public payload against the private reference, without exposing its rows. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createServer, get } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateSyntheticCorpus } from '../fixtures/synthetic/corpus.js';
import { SYNTHETIC_FX, transactionToEvidenceRecord } from '../fixtures/synthetic/generate.js';
import { ReportStore } from '../apps/server/src/store.js';
import { PackPublisher } from '../apps/server/src/publisher.js';
import { createApp } from '../apps/server/src/app.js';
import { applyAdapter, capContributorWeights, daysBetween, decodeAdapter, decodePrototype, euclideanDistance,
  kernelGroupWeights, mixtureQuantiles, normalizeSale, reputationFromReviews, weightedQuantile } from '@pricemesh/domain';
import { sourceEvidenceScore } from '@pricemesh/pack';
import type { ComparisonPack } from '@pricemesh/domain';

const temporaryParent=resolve(tmpdir());
const directory=mkdtempSync(join(temporaryParent,'pricemesh-final-artifact-'));
const store=new ReportStore(':memory:');
try {
  const corpus=generateSyntheticCorpus();
  const records=corpus.records.map(record=>({...record,evidenceRecord:transactionToEvidenceRecord(record)}));
  store.seed(records);
  const cache=JSON.parse(readFileSync('generated/embedding-cache.json','utf8')) as {records:{id:string;embedding:number[];split:string}[]};
  const publisher=new PackPublisher({store,dataDirectory:directory,generatedDirectory:resolve('generated'),asOf:'2026-10-04',fxRates:SYNTHETIC_FX,
    encodeDescription:async()=>{throw new Error('The frozen initial corpus must use its actual cached embeddings.');}});
  const built=await publisher.publish();
  const packDirectory=join(directory,'packs',built.manifest.packVersion);
  const pack:ComparisonPack=JSON.parse(readFileSync(join(packDirectory,'pack.json'),'utf8'));
  const adapter=decodeAdapter(readFileSync(join(packDirectory,'adapter.f32')));
  const prototypes=readFileSync(join(packDirectory,'prototypes.f32'));
  const vectors=new Map(cache.records.map(record=>[record.id,applyAdapter(record.embedding,adapter)]));
  const groupVectors=pack.groups.map(group=>({id:group.id,prior:group.prior,radius:group.radius,vector:decodePrototype(prototypes,group,'float32-le')}));
  const membership=store.db.prepare('SELECT report_id FROM report_publication_membership WHERE included=1').all() as {report_id:string}[];
  const included=new Set(membership.map(row=>row.report_id));
  const reference=records.filter(record=>included.has(record.id)).map(record=> {
    const normalized=normalizeSale(record.facts,'TZS',SYNTHETIC_FX);
    if(!normalized.ok) throw new Error('Published source failed independent normalization.');
    return {id:record.id,contributorId:record.contributorId,price:normalized.value.netCropPrice,
      preliminaryWeight:sourceEvidenceScore(record).score/100*reputationFromReviews(records,record.contributorId).score
        *2**(-daysBetween(record.facts.saleDate.value!,'2026-10-04')/30),vector:vectors.get(record.id)!};
  });
  const measurements:Record<string,unknown>={};
  for(const split of ['dev','test']) {
    const errors:number[]=[];
    const queries=cache.records.filter(record=>record.split===split && !corpus.metadata[record.id]?.stressType);
    for(const query of queries) {
      const queryVector=vectors.get(query.id)!;
      const comparable=reference.map(record=>({...record,distance:euclideanDistance(record.vector,queryVector)}))
        .filter(record=>record.distance<=pack.calibration.maxDistance);
      if(comparable.length<10 || new Set(comparable.map(record=>record.contributorId)).size<5) continue;
      const weighted=capContributorWeights(comparable.map(record=>({...record,preliminaryWeight:record.preliminaryWeight
        *Math.exp(-(record.distance**2)/(2*pack.calibration.kernelTemperature**2))})));
      const privateMedian=Number(weightedQuantile(weighted,.5));
      const groupWeights=kernelGroupWeights(queryVector,groupVectors,pack.calibration.kernelTemperature,pack.calibration.maxDistance);
      if(!groupWeights.length) continue;
      const publicMedian=Number(mixtureQuantiles(groupWeights.map(weight=>({weight:weight.weight,
        distribution:pack.groups.find(group=>group.id===weight.id)!.distribution}))).q50);
      errors.push(Math.abs(publicMedian-privateMedian));
    }
    errors.sort((left,right)=>left-right);
    const percentile=(fraction:number)=> {const position=(errors.length-1)*fraction;const lower=Math.floor(position),upper=Math.ceil(position);
      return errors.length?errors[lower]!+(errors[upper]!-errors[lower]!)*(position-lower):null;};
    measurements[split]={queries:queries.length,supported:errors.length,medianAbsoluteError:percentile(.5),p90AbsoluteError:percentile(.9)};
  }
  const json=JSON.stringify(pack);
  if(['contributorId','rawText','originalText','clientReportId','lotId','attachmentRefs'].some(field=>json.includes(`"${field}"`))) throw new Error('Private field leaked into public pack.');
  const server=createServer(createApp({store,dataDirectory:directory}));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const files=[];
  try {
    for(const file of built.manifest.files) {
      const transferred=await new Promise<{bytes:Buffer;contentEncoding:string}>((resolve,reject)=> {
        const call=get({host:'127.0.0.1',port:(server.address() as AddressInfo).port,
          path:`/packs/${built.manifest.packVersion}/${file.path}`,agent:false,headers:{'Accept-Encoding':'gzip'}},response=> {
          const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));
          response.on('end',()=>resolve({bytes:Buffer.concat(chunks),contentEncoding:String(response.headers['content-encoding']??'identity')}));
          response.on('error',reject);
        });call.on('error',reject);
      });
      const decoded=transferred.contentEncoding==='gzip'?gunzipSync(transferred.bytes):transferred.bytes;
      if(decoded.length!==file.decodedBytes || createHash('sha256').update(decoded).digest('hex')!==file.sha256) throw new Error('Transport changed the hashed decoded pack bytes.');
      files.push({path:file.path,decodedBytes:file.decodedBytes,gzipEstimateBytes:gzipSync(readFileSync(join(packDirectory,file.path))).length,
        transportBodyBytes:transferred.bytes.length,contentEncoding:transferred.contentEncoding});
    }
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  const report={synthetic:true,encoderVersion:built.manifest.encoderVersion,preprocessingVersion:built.manifest.preprocessingVersion,
    adapterVersion:built.manifest.adapterVersion,groups:pack.groups.length,includedLots:included.size,measurements,files,
    totalDecodedBytes:files.reduce((sum,file)=>sum+file.decodedBytes,0),totalGzipEstimateBytes:files.reduce((sum,file)=>sum+file.gzipEstimateBytes,0),
    totalTransportBodyBytes:files.reduce((sum,file)=>sum+file.transportBodyBytes,0),
    transferMeasurement:'Actual negotiated gzip HTTP response bodies; manifest, headers and framing excluded.'};
  writeFileSync('generated/final-pack-verification.json',JSON.stringify(report,null,2)+'\n');
  console.info(JSON.stringify(report,null,2));
} finally {
  store.close();
  // The recursive cleanup is confined to the freshly created temporary validation directory.
  if(directory.startsWith(temporaryParent+requireSeparator()) && directory.includes('pricemesh-final-artifact-')) rmSync(directory,{recursive:true,force:true});
}
function requireSeparator():string {return process.platform==='win32'?'\\':'/';}
