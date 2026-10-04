import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import compression from 'compression';
import multer from 'multer';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { evidenceRecordSchema, moneyBasisSchema, preprocessDescription, saleFactsSchema } from '@pricemesh/domain';
import { ReportStore, StoreConflict, StoreMissing } from './store.js';
import type { PackManifest } from '@pricemesh/domain';
import { evidenceUploadSchema, factsFromEvidence, uploadFromEvidence } from './evidence.js';
import { PublicationRejected, PublisherUnavailable } from './publisher.js';

const reportSchema = z.object({
  clientReportId: z.string().min(16).max(128),
  contributorId: z.string().min(1).max(128), cooperativeId: z.string().min(1).max(128),
  lotId: z.string().min(1).max(128), facts: saleFactsSchema,
  originalText: z.string().max(16_000), inputLanguage: z.enum(['en','fr','sw','de']),
  consent: z.object({upload:z.literal(true),aggregateUse:z.boolean(),recordedAt:z.string().datetime()}),
  synthetic: z.literal(true),
}).strict();
const reviewSchema = z.object({
  outcome: z.enum(['approved','rejected','withdrawn']), reason:z.string().trim().min(3).max(2000),
  verification:z.enum(['seller_reported','receipt_attached','cooperative_attested']).optional(),
  facts:saleFactsSchema.optional(),
  corrections:z.object({descriptionText:z.string().max(16000).optional(),money:moneyBasisSchema.partial().optional(),
    context:evidenceRecordSchema.shape.context.partial().optional(),observations:evidenceRecordSchema.shape.observations.optional()}).strict().optional(),
}).strict();
const comparisonLabelSchema=z.object({leftReportId:z.string().min(1),rightReportId:z.string().min(1),
  label:z.enum(['comparable','non_comparable','unknown']),rationale:z.string().trim().min(3).max(2000)}).strict();

export interface AppOptions {
  store: ReportStore;
  dataDirectory: string;
  reviewerSecret?: string;
  webDirectory?: string;
  publish?: () => {manifest:PackManifest;summary:unknown} | Promise<{manifest:PackManifest;summary:unknown}>;
  publisherStatus?:()=>{ready:boolean;reason?:string};
}

const token = (authorization: string | undefined): string => authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
const constantTimeEqual = (a:string,b:string):boolean => {
  const left=Buffer.from(a); const right=Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left,right);
};

export function createApp(options: AppOptions) {
  const app = express();
  const { store } = options;
  const dataDirectory = resolve(options.dataDirectory);
  const evidenceDirectory = join(dataDirectory,'private-evidence');
  mkdirSync(evidenceDirectory,{recursive:true});
  app.disable('x-powered-by');
  app.use(express.json({limit:'128kb'}));
  app.use((request,response,next) => {
    response.setHeader('X-Content-Type-Options','nosniff');
    if (request.path.startsWith('/api/reports') || request.path.startsWith('/api/reviewer')) {
      response.setHeader('Cache-Control','no-store');
    }
    next();
  });
  app.use(compression({threshold:1024,filter:(request,response)=> {
    // Source custody and status responses stay uncompressed; only public assets benefit from negotiated transport compression.
    if(request.path.startsWith('/api/reports') || request.path.startsWith('/api/reviewer')) return false;
    if(/^\/(?:packs\/)[^/]+\/(?:adapter|prototypes)\.(?:f32|i8)$/.test(request.path)) return true;
    return compression.filter(request,response);
  }}));

  const reviewer: RequestHandler = (request,response,next) => {
    if (!options.reviewerSecret) {
      response.status(503).json({error:'Reviewer access has not been configured.'}); return;
    }
    if (!constantTimeEqual(token(request.get('authorization')),options.reviewerSecret)) {
      response.status(401).json({error:'Reviewer credential required.'}); return;
    }
    next();
  };
  const owner: RequestHandler = (request,response,next) => {
    if (!store.authorizeReport(String(request.params.id),token(request.get('authorization')))) {
      response.status(401).json({error:'Report status token required.'}); return;
    }
    next();
  };

  app.get('/health',(_request,response) => response.json({status:'ok',service:'pricemesh',synthetic:true,resettableDemo:true,
    publisher:options.publisherStatus?.()??{ready:Boolean(options.publish)}}));
  app.get('/api/packs',(request,response) => {
    const cropId = String(request.query.cropId || 'coffee');
    const regionId = String(request.query.regionId || 'ondera-demo');
    const row=store.db.prepare('SELECT manifest FROM pack_versions WHERE crop_id=? AND region_id=? ORDER BY sequence DESC LIMIT 1')
      .get(cropId,regionId) as {manifest:string}|undefined;
    if (!row) {response.status(404).json({error:'No qualified aggregate pack is available for this scope.'});return;}
    response.setHeader('Cache-Control','no-cache');
    response.json(JSON.parse(row.manifest));
  });
  app.get('/packs/:version/:filename',(request,response) => {
    const version=String(request.params.version); const filename=String(request.params.filename);
    const row=store.db.prepare('SELECT manifest FROM pack_versions WHERE version=?').get(version) as {manifest:string}|undefined;
    if (!row) {response.status(404).json({error:'Pack not found.'});return;}
    const manifest = JSON.parse(row.manifest) as PackManifest;
    // Only immutable, explicitly published aggregate assets have public URLs.
    const allowed=['manifest.json',...manifest.files.map(file=>file.path)];
    if (!allowed.includes(filename) || !/^[a-zA-Z0-9._-]+$/.test(version) || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
      response.status(404).json({error:'Pack asset not found.'});return;
    }
    const path=join(dataDirectory,'packs',version,filename);
    if (!existsSync(path)) {response.status(503).json({error:'Published asset unavailable.'});return;}
    response.setHeader('Cache-Control','public, max-age=31536000, immutable');
    response.type(filename.endsWith('.json') ? 'application/json' : 'application/octet-stream').send(readFileSync(path));
  });

  app.post('/api/reports',(request,response) => {
    const evidenceParsed=evidenceUploadSchema.safeParse(request.body);
    if(evidenceParsed.success) {
      const result=store.accept(uploadFromEvidence(evidenceParsed.data));
      response.status(result.duplicate?200:201).json(result);return;
    }
    const parsed=reportSchema.safeParse(request.body);
    if (!parsed.success) {response.status(400).json({error:'Invalid fictional sale report.',issues:parsed.error.flatten()});return;}
    const result=store.accept(parsed.data);
    response.status(result.duplicate ? 200 : 201).json(result);
  });
  app.get('/api/reports/:id/status',owner,(request,response) => response.json(store.status(String(request.params.id))));

  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:2}});
  app.post('/api/reports/:id/evidence',owner,upload.single('file'),(request,response) => {
    const file=request.file;
    const kind=request.body.kind;
    if (!file || !['receipt','photo'].includes(kind)) {
      response.status(400).json({error:'Attach one PNG/JPEG file and specify kind receipt or photo.'});return;
    }
    const png=file.buffer.length>=8 && file.buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=file.buffer.length>=3 && file.buffer[0]===0xff && file.buffer[1]===0xd8 && file.buffer[2]===0xff;
    if ((!png || file.mimetype!=='image/png') && (!jpeg || file.mimetype!=='image/jpeg')) {
      response.status(415).json({error:'Only PNG/JPEG evidence files are supported.'});return;
    }
    const id=randomUUID(); const path=join(evidenceDirectory,id+(png?'.png':'.jpg'));
    writeFileSync(path,file.buffer,{flag:'wx'});
    store.addEvidence(String(request.params.id),{id,path,mimeType:file.mimetype,bytes:file.size,
      sha256:createHash('sha256').update(file.buffer).digest('hex'),kind});
    response.status(201).json({evidenceId:id,bytes:file.size,kind});
  });

  app.get('/api/reviewer/reports',reviewer,(_request,response) => {
    response.json({synthetic:true,reports:store.all().map(report=>({...report,...report.evidenceRecord,publication:store.status(report.id)?.publication}))});
  });
  app.get('/api/reviewer/evidence/:id',reviewer,(request,response) => {
    const row=store.db.prepare('SELECT private_path,mime_type FROM evidence WHERE id=?').get(String(request.params.id)) as {private_path:string;mime_type:string}|undefined;
    if (!row) {response.status(404).json({error:'Evidence not found.'});return;}
    response.type(row.mime_type).sendFile(row.private_path);
  });
  app.post('/api/reviewer/reports/:id/review',reviewer,(request,response) => {
    const parsed=reviewSchema.safeParse(request.body);
    if (!parsed.success) {response.status(400).json({error:'Invalid review.',issues:parsed.error.flatten()});return;}
    const review=parsed.data;
    const current=store.find(String(request.params.id));
    if(!current) {response.status(404).json({error:'Report not found.'});return;}
    let evidence=current.evidenceRecord;
    let facts=review.facts;
    if(review.corrections) {
      if(!evidence) {response.status(400).json({error:'This legacy record requires corrections in facts.'});return;}
      const corrected=evidenceRecordSchema.safeParse({...evidence,...review.corrections,
        ...(review.corrections.money?{money:{...evidence.money,...review.corrections.money}}:{}),
        ...(review.corrections.context?{context:{...evidence.context,...review.corrections.context}}:{})});
      if(!corrected.success) {response.status(400).json({error:'Corrections do not form a valid evidence record.'});return;}
      evidence=corrected.data;evidence.descriptionText=preprocessDescription(evidence.descriptionText).description;
      facts=factsFromEvidence(evidence);
    }
    const report=store.review(String(request.params.id),review.outcome,review.reason,review.verification,facts,evidence);
    response.json({reportId:report.id,reviewState:report.reviewState,status:store.status(report.id)});
  });
  app.post('/api/reviewer/comparisons',reviewer,(request,response)=> {
    const parsed=comparisonLabelSchema.safeParse(request.body);
    if (!parsed.success) {response.status(400).json({error:'Invalid comparison label.',issues:parsed.error.flatten()});return;}
    const value=parsed.data;
    store.labelComparison(value.leftReportId,value.rightReportId,value.label,value.rationale);
    response.status(201).json({status:'recorded',trainingState:value.label==='unknown'?'clarification_only':'queued',label:value.label});
  });
  let publishing=false;
  app.post('/api/reviewer/publish',reviewer,async (_request,response,next) => {
    if (publishing) {response.status(409).json({error:'A publication is already in progress.'});return;}
    if (!options.publish) {response.status(503).json({error:'Publisher runtime is not ready.'});return;}
    publishing=true;
    try { response.status(201).json(await options.publish()); }
    catch(error) {next(error);}
    finally {publishing=false;}
  });

  app.use('/api',(_request,response)=>response.status(404).json({error:'API route not found.'}));
  app.use('/packs',(_request,response)=>response.status(404).json({error:'Pack asset not found.'}));
  if (options.webDirectory && existsSync(options.webDirectory)) {
    app.use(express.static(options.webDirectory,{dotfiles:'deny'}));
    app.get('/{*path}',(_request,response) => response.sendFile(join(resolve(options.webDirectory!),'index.html')));
  }
  const errors: ErrorRequestHandler=(error,_request,response,_next)=> {
    if (error instanceof StoreConflict) {response.status(409).json({error:error.message});return;}
    if (error instanceof StoreMissing) {response.status(404).json({error:error.message});return;}
    if (error instanceof PublisherUnavailable) {response.status(503).json({error:error.message});return;}
    if (error instanceof PublicationRejected) {response.status(422).json({error:error.message});return;}
    if (error instanceof multer.MulterError) {response.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?'Evidence exceeds 5 MB.':'Invalid evidence upload.'});return;}
    if (error instanceof SyntaxError) {response.status(400).json({error:'Invalid JSON.'});return;}
    // Error internals can contain private records and filesystem paths: never return them.
    console.error('Request failed:',error instanceof Error ? error.name : 'unknown error');
    response.status(500).json({error:'The operation could not be completed.'});
  };
  app.use(errors);
  return app;
}
