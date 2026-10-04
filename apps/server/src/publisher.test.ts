import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateSyntheticCorpus } from '../../../fixtures/synthetic/corpus.js';
import { SYNTHETIC_FX, transactionToEvidenceRecord } from '../../../fixtures/synthetic/generate.js';
import { ReportStore } from './store.js';
import { PackPublisher } from './publisher.js';
import { createApp } from './app.js';
import { PREPROCESSING_VERSION } from '@pricemesh/domain';

const resources:{root:string;store:ReportStore}[]=[];
afterEach(()=> {for(const {root,store} of resources.splice(0)) {store.close();rmSync(root,{recursive:true,force:true});}});

async function wireResponse(app:ReturnType<typeof createApp>,path:string,authorization?:string) {
  const server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    return await new Promise<{headers:Record<string,unknown>;bytes:Buffer}>( (resolve,reject)=> {
      const call=get({host:'127.0.0.1',port:(server.address() as AddressInfo).port,path,agent:false,
        headers:{'Accept-Encoding':'gzip',...(authorization?{Authorization:authorization}:{})}},response=> {
        const chunks:Buffer[]=[];
        response.on('data',chunk=>chunks.push(Buffer.from(chunk)));
        response.on('end',()=>resolve({headers:response.headers,bytes:Buffer.concat(chunks)}));
        response.on('error',reject);
      });
      call.on('error',reject);
    });
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

describe('Contribution to immutable aggregate publication',()=> {
  it('distinguishes acceptance, review and inclusion, and retains the current pack after failed publication',async()=> {
    const root=mkdtempSync(join(tmpdir(),'pricemesh-publication-'));
    const generated=join(root,'generated');mkdirSync(generated);
    const store=new ReportStore(':memory:');resources.push({root,store});
    const transactions=generateSyntheticCorpus().records.slice(0,96).map(record=>({...record,evidenceRecord:transactionToEvidenceRecord(record)}));
    store.seed(transactions);
    const vector=[1,...Array(383).fill(0)];
    const model={encoderVersion:'mathematical-fixture',preprocessingVersion:PREPROCESSING_VERSION,adapterVersion:'test-only-baseline',
      trainingStatus:'baseline',calibrationVersion:'test-only',adapter:Array(384).fill(1),
      calibration:{status:'pending',minSimilarity:-1,minMargin:0,kernelTemperature:.3,maxDistance:1},
      groups:[{id:'test-group',centroid:vector,radius:.5,topics:[],context:{species:'arabica',productForm:'parchment',
        deliveryTerms:'buyer_collects',paymentTerms:'immediate'},memberIds:transactions.map(record=>record.id)}]};
    writeFileSync(join(generated,'learned-groups.json'),JSON.stringify(model));
    writeFileSync(join(generated,'embedding-cache.json'),JSON.stringify({encoderVersion:model.encoderVersion,preprocessingVersion:model.preprocessingVersion,
      records:transactions.map(record=>({id:record.id,embedding:vector,split:'train',descriptionText:record.evidenceRecord.descriptionText}))}));
    const publisher=new PackPublisher({store,dataDirectory:root,generatedDirectory:generated,asOf:'2026-10-04',fxRates:SYNTHETIC_FX,
      encodeDescription:async()=>vector});
    const app=createApp({store,dataDirectory:root,reviewerSecret:'fixture-secret',publish:()=>publisher.publish()});
    expect(publisher.needsPublication()).toBe(true);
    const first=await request(app).post('/api/reviewer/publish').set('Authorization','Bearer fixture-secret').expect(201);
    expect(publisher.needsPublication()).toBe(false);
    const own={clientReportId:'new-fictional-report-001',lotId:'new-fictional-lot',contributorId:'new-fictional-contributor',custodianId:'fictional-cooperative',
      rawText:'Arabica parchment in closed sacks. Sold at TZS 6200/kg.',language:'en',descriptionText:'Dry Arabica parchment in closed sacks. Buyer collects and pays immediately.',
      observations:[],money:{amount:'6200',currency:'TZS',basis:'per_kg',cropCharges:'0',status:'confirmed',sourceRefs:['input:text']},
      context:{cropId:'coffee',marketAreaId:'ondera-demo',marketTier:'farmgate',date:'2026-10-04',status:'confirmed',sourceRefs:['session:confirmed']},
      consent:{upload:true,aggregateUse:true,recordedAt:'2026-10-04T00:00:00.000Z'},synthetic:true};
    const uploaded=await request(app).post('/api/reports').send(own).expect(201);
    const statusUrl=`/api/reports/${uploaded.body.reportId}/status`;
    const bearer=`Bearer ${uploaded.body.statusToken}`;
    const accepted=await request(app).get(statusUrl).set('Authorization',bearer).expect(200);
    expect(accepted.body.reviewState).toBe('unreviewed');expect(accepted.body.publication).toBeNull();
    await request(app).post(`/api/reviewer/reports/${uploaded.body.reportId}/review`).set('Authorization','Bearer fixture-secret')
      .send({outcome:'approved',reason:'Confirmed fictional unit quote and consent.'}).expect(200);
    const approved=await request(app).get(statusUrl).set('Authorization',bearer).expect(200);
    expect(approved.body.reviewState).toBe('approved');expect(approved.body.publication).toBeNull();
    const second=await request(app).post('/api/reviewer/publish').set('Authorization','Bearer fixture-secret').expect(201);
    expect(second.body.manifest.packVersion).not.toBe(first.body.manifest.packVersion);
    const included=await request(app).get(statusUrl).set('Authorization',bearer).expect(200);
    expect(included.body.publication).toMatchObject({packVersion:second.body.manifest.packVersion,included:true});
    const latest=await request(app).get('/api/packs?cropId=coffee&regionId=ondera-demo').expect(200);
    expect(latest.body.packVersion).toBe(second.body.manifest.packVersion);
    const pack=await request(app).get(`/packs/${latest.body.packVersion}/pack.json`).expect(200);
    expect(JSON.stringify(pack.body)).not.toContain(own.contributorId);expect(JSON.stringify(pack.body)).not.toContain(own.rawText);
    await request(app).get(`/packs/${latest.body.packVersion}/embedding-cache.json`).expect(404);
    const transported=await wireResponse(app,`/packs/${latest.body.packVersion}/pack.json`);
    expect(transported.headers['content-encoding']).toBe('gzip');
    const decoded=gunzipSync(transported.bytes);
    const declared=latest.body.files.find((file:{path:string})=>file.path==='pack.json');
    expect(decoded.length).toBe(declared.decodedBytes);
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(declared.sha256);
    expect(transported.bytes.length).toBeLessThan(decoded.length);
    const privateTransport=await wireResponse(app,'/api/reviewer/reports','Bearer fixture-secret');
    expect(privateTransport.bytes.length).toBeGreaterThan(1024);
    expect(privateTransport.headers['content-encoding']).toBeUndefined();
    expect(privateTransport.headers['cache-control']).toBe('no-store');
    expect(readFileSync(join(root,'packs',first.body.manifest.packVersion,'pack.json'))).toBeTruthy();
    // A thin rebuild is rejected before the latest pointer changes.
    writeFileSync(join(generated,'learned-groups.json'),JSON.stringify({...model,groups:[{...model.groups[0],memberIds:transactions.slice(0,3).map(record=>record.id)}]}));
    await request(app).post('/api/reviewer/publish').set('Authorization','Bearer fixture-secret').expect(422);
    const unchanged=await request(app).get('/api/packs').expect(200);expect(unchanged.body.packVersion).toBe(second.body.manifest.packVersion);
    // Startup notices a new prepared model without deleting any local contribution or previous pack.
    writeFileSync(join(generated,'learned-groups.json'),JSON.stringify({...model,adapterVersion:'new-prepared-model'}));
    expect(publisher.needsPublication()).toBe(true);
    await publisher.publish();expect(publisher.needsPublication()).toBe(false);
    expect(store.find(uploaded.body.reportId)).toBeTruthy();
    expect(readFileSync(join(root,'packs',second.body.manifest.packVersion,'pack.json'))).toBeTruthy();
    const beforeStale=await request(app).get('/api/packs').expect(200);
    // Equally stale cache/model files cannot pass merely because they agree with each other.
    writeFileSync(join(generated,'learned-groups.json'),JSON.stringify({...model,preprocessingVersion:'obsolete-preprocessing'}));
    const cache=JSON.parse(readFileSync(join(generated,'embedding-cache.json'),'utf8'));
    writeFileSync(join(generated,'embedding-cache.json'),JSON.stringify({...cache,preprocessingVersion:'obsolete-preprocessing'}));
    await request(app).post('/api/reviewer/publish').set('Authorization','Bearer fixture-secret').expect(422);
    const afterStale=await request(app).get('/api/packs').expect(200);
    expect(afterStale.body.packVersion).toBe(beforeStale.body.packVersion);
    writeFileSync(join(generated,'learned-groups.json'),JSON.stringify(model));
    writeFileSync(join(generated,'embedding-cache.json'),JSON.stringify(cache));
    // Imported old evidence with unresolved unit-price text must not reuse a now-unrelated cached vector.
    const corrected=store.find(transactions[0]!.id)!;
    store.review(corrected.id,'approved','Imported corrected source requires currency clarification.',undefined,undefined,
      {...corrected.evidenceRecord!,descriptionText:'Dry Arabica parchment in closed sacks, 5100/kg.'});
    await publisher.publish();
    expect(store.status(corrected.id)!.publication!.included).toBe(false);
  });
});
