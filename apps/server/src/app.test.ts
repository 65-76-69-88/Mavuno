import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySaleFacts, fact, normalizeMoneyBasis } from '@pricemesh/domain';
import { createApp } from './app.js';
import { ReportStore } from './store.js';

const roots: string[]=[];
const stores: ReportStore[]=[];
afterEach(()=> {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});
function fixture(reviewerSecret='test-only-secret') {
  const dataDirectory=mkdtempSync(join(tmpdir(),'pricemesh-server-')); roots.push(dataDirectory);
  const store=new ReportStore(':memory:'); stores.push(store);
  return {store,app:createApp({store,dataDirectory,reviewerSecret})};
}
function payload(clientReportId='report-000000000001') {
  const facts=emptySaleFacts();
  Object.assign(facts,{cropId:fact('coffee','confirmed'),species:fact('arabica','confirmed'),
    productForm:fact('parchment','confirmed'),sourceQuantity:fact('50','confirmed'),sourceUnit:fact('kg','confirmed'),
    quantityKg:fact('50','confirmed'),saleDate:fact('2026-10-04','confirmed'),marketAreaId:fact('ondera-demo','confirmed'),
    saleChannel:fact('farmgate','confirmed'),deliveryTerms:fact('buyer_collects','confirmed'),paymentTerms:fact('immediate','confirmed'),
    currency:fact('TZS','confirmed'),priceBasis:fact('lot','confirmed'),cropConsideration:fact('300000','confirmed'),
    saleCosts:fact('0','confirmed'),loanSettlement:fact('60000','confirmed'),sorting:fact('sorted','reported')});
  return {clientReportId,contributorId:'fictional-contributor',cooperativeId:'fictional-cooperative',lotId:clientReportId,
    facts,originalText:'My fictional 50 kg lot of hand sorted Arabica parchment sold for TZS 300000.',inputLanguage:'en',
    consent:{upload:true,aggregateUse:true,recordedAt:'2026-10-04T00:00:00.000Z'},synthetic:true};
}
describe('Private contribution boundary',()=> {
  it('accepts one report across retries, protects status, and keeps review separate from upload',async()=> {
    const {app,store}=fixture();
    const first=await request(app).post('/api/reports').send(payload()).expect(201);
    const retry=await request(app).post('/api/reports').send(payload()).expect(200);
    expect(retry.body.reportId).toBe(first.body.reportId);
    expect(retry.body.statusToken).toBe(first.body.statusToken);
    expect(store.all()).toHaveLength(1);
    expect(first.body.reviewState).toBe('unreviewed');
    const url=`/api/reports/${first.body.reportId}/status`;
    await request(app).get(url).expect(401);
    const status=await request(app).get(url).set('Authorization',`Bearer ${first.body.statusToken}`).expect(200);
    expect(status.body.publication).toBeNull();
    expect(JSON.stringify(status.body)).not.toContain('originalText');
    await request(app).post('/api/reports').send({...payload(),originalText:'Different facts with same ID'}).expect(409);
  });

  it('fails closed without a reviewer secret and never exposes source records through public routes',async()=> {
    const {app,store}=fixture('');
    await request(app).post('/api/reports').send(payload()).expect(201);
    await request(app).get('/api/reviewer/reports').expect(503);
    await request(app).get('/api/reports').expect(404);
    await request(app).get('/packs/../../reports.sqlite').expect(404);
    expect(store.all()).toHaveLength(1);
  });

  it('authorizes review on the server and gives a unique lot only one reputation judgement',async()=> {
    const {app,store}=fixture();
    const first=await request(app).post('/api/reports').send(payload()).expect(201);
    const url=`/api/reviewer/reports/${first.body.reportId}/review`;
    await request(app).post(url).send({outcome:'approved',reason:'Fictional receipt inspected'}).expect(401);
    for (let attempt=0;attempt<2;attempt++) {
      await request(app).post(url).set('Authorization','Bearer test-only-secret')
        .send({outcome:'approved',reason:'Fictional receipt inspected',verification:'cooperative_attested'}).expect(200);
    }
    const total=store.db.prepare('SELECT count(*) AS count FROM contributor_reviews').get() as {count:number};
    expect(total.count).toBe(1);
    const status=await request(app).get(`/api/reports/${first.body.reportId}/status`)
      .set('Authorization',`Bearer ${first.body.statusToken}`).expect(200);
    expect(status.body.reviewState).toBe('approved');
    expect(status.body.publication).toBeNull();
  });

  it('keeps images private and distinguishes crop photos from receipt corroboration',async()=> {
    const {app,store}=fixture();
    const first=await request(app).post('/api/reports').send(payload()).expect(201);
    const url=`/api/reports/${first.body.reportId}/evidence`;
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=','base64');
    await request(app).post(url).field('kind','photo').attach('file',png,{filename:'photo.png',contentType:'image/png'}).expect(401);
    const evidence=await request(app).post(url).set('Authorization',`Bearer ${first.body.statusToken}`)
      .field('kind','photo').attach('file',png,{filename:'photo.png',contentType:'image/png'}).expect(201);
    expect(store.find(first.body.reportId)?.verification).toBe('seller_reported');
    await request(app).get(`/api/reviewer/evidence/${evidence.body.evidenceId}`).expect(401);
    await request(app).get(`/private-evidence/${evidence.body.evidenceId}.png`).expect(404);
    await request(app).get(`/api/reviewer/evidence/${evidence.body.evidenceId}`)
      .set('Authorization','Bearer test-only-secret').expect(200);
    await request(app).post(url).set('Authorization',`Bearer ${first.body.statusToken}`)
      .field('kind','receipt').attach('file',Buffer.from('not an image'),{filename:'receipt.png',contentType:'image/png'}).expect(415);
  });

  it('requires fictional data and explicit upload consent',async()=> {
    const {app}=fixture();
    await request(app).post('/api/reports').send({...payload(),synthetic:false}).expect(400);
    const noConsent=payload();noConsent.consent.upload=false;
    await request(app).post('/api/reports').send(noConsent).expect(400);
  });

  it('accepts an open evidence record, preserves observations, and corrects a unit quote without inventing weight',async()=> {
    const {app,store}=fixture();
    const input={clientReportId:'open-evidence-0001',lotId:'lot-open-1',contributorId:'fictional-new-farmer',custodianId:'fictional-cooperative',
      rawText:'Dry Arabica parchment, stored in closed sacks. TZS 6000/kg.',language:'en',
      observations:[{id:'observation-1',statement:'Stored in closed sacks.',polarity:'positive',status:'reported',sourceRefs:['input:text']}],
      descriptionText:'Dry Arabica parchment coffee, stored in closed sacks. Buyer collects and pays immediately.',
      money:{amount:'6000',currency:'TZS',basis:'per_kg',cropCharges:'0',status:'confirmed',sourceRefs:['input:text']},
      context:{cropId:'coffee',marketAreaId:'ondera-demo',date:'2026-10-04',marketTier:'farmgate',status:'confirmed',sourceRefs:['session:confirmed']},
      consent:{upload:true,aggregateUse:true,recordedAt:'2026-10-04T00:00:00.000Z'},synthetic:true};
    const accepted=await request(app).post('/api/reports').send(input).expect(201);
    expect(store.find(accepted.body.reportId)?.facts.quantityKg.value).toBeNull();
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM observations').get() as {count:number}).count).toBe(1);
    await request(app).post(`/api/reviewer/reports/${accepted.body.reportId}/review`).set('Authorization','Bearer test-only-secret')
      .send({outcome:'approved',reason:'Fictional confirmed unit quote corrected.',corrections:{money:{amount:'6200'}}}).expect(200);
    const source=store.find(accepted.body.reportId)!.evidenceRecord!;
    expect(source.money!.amount).toBe('6200');expect(source.money!.quantityKg).toBeUndefined();
    const normalized=normalizeMoneyBasis(source.money!,source.context.date!,'TZS',[]);
    expect(normalized.ok && normalized.value.netCropPrice).toBe('6200');
    const duplicateObservation={...input,clientReportId:'open-evidence-0002',observations:[...input.observations,...input.observations]};
    await request(app).post('/api/reports').send(duplicateObservation).expect(400);
  });
});
