import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSyntheticCorpus } from '../../../fixtures/synthetic/corpus.js';
import { SYNTHETIC_CLOCK, SYNTHETIC_FX, transactionToEvidenceRecord } from '../../../fixtures/synthetic/generate.js';
import { encodeDescription } from '../../../training/encoder.js';
import { createApp } from './app.js';
import { PackPublisher } from './publisher.js';
import { ReportStore } from './store.js';

config({quiet:true});
const port=Number(process.env.PORT??3001);
const dataDirectory=resolve(process.env.DATA_DIR??'data');
const store=new ReportStore(resolve(dataDirectory,'reports.sqlite'));
const corpus=generateSyntheticCorpus(SYNTHETIC_CLOCK);
store.seed(corpus.records.map(record=>({...record,evidenceRecord:transactionToEvidenceRecord(record)})));
const generatedDirectory=existsSync(resolve('generated/learned-groups.json')) && existsSync(resolve('generated/embedding-cache.json'))
  ?resolve('generated'):resolve('artifacts/synthetic');
const publisher=new PackPublisher({store,dataDirectory,generatedDirectory,asOf:SYNTHETIC_CLOCK,
  fxRates:SYNTHETIC_FX,encodeDescription});
const app=createApp({store,dataDirectory,reviewerSecret:process.env.REVIEWER_SECRET||undefined,
  webDirectory:existsSync(resolve('dist/web'))?resolve('dist/web'):undefined,publish:()=>publisher.publish(),publisherStatus:()=>publisher.availability()});

// Missing runtime/model artifacts leave the server usable for setup and contributions, without a fake reference.
if(publisher.availability().ready) {
  try{if(publisher.needsPublication()) {await publisher.publish();console.info('Activated the current fictional model and aggregate pack.');}}
  catch(error){console.warn('Initial aggregate publication unavailable:',error instanceof Error?error.message:'unknown error');}
}
const server=app.listen(port,()=>console.info(`PriceMesh demo service listening on port ${port}.`));
function shutdown() {server.close(()=>{store.close();process.exit(0);});}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
