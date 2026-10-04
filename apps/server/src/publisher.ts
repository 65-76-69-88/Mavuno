import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyAdapter, assignToLearnedGroup, buildComparisonPack, learnedModelSchema } from '@pricemesh/pack';
import { POLICY_VERSION, PREPROCESSING_VERSION, preprocessDescription } from '@pricemesh/domain';
import type { FxRate, PackManifest } from '@pricemesh/domain';
import { ReportStore } from './store.js';

const cacheSchema=z.object({encoderVersion:z.string(),preprocessingVersion:z.string(),
  records:z.array(z.object({id:z.string(),embedding:z.array(z.number().finite()).length(384),split:z.enum(['train','dev','test']),
    descriptionText:z.string().optional(),descriptionHash:z.string().optional()}).passthrough())}).passthrough();
export class PublisherUnavailable extends Error {}
export class PublicationRejected extends Error {}
export type PublisherOptions={store:ReportStore;dataDirectory:string;generatedDirectory:string;asOf:string;fxRates:FxRate[];
  encodeDescription:(text:string)=>Promise<number[]>};

/** Publish complete immutable files, then atomically expose their version and own-report membership. */
export class PackPublisher {
  constructor(private readonly options:PublisherOptions) {}

  availability():{ready:boolean;reason?:string} {
    const directory=resolve(this.options.generatedDirectory);
    if(!existsSync(join(directory,'learned-groups.json')) || !existsSync(join(directory,'embedding-cache.json'))) {
      return {ready:false,reason:'Prepare the local encoder cache and trained aggregate groups before publication.'};
    }
    return {ready:true};
  }

  private inputFingerprint(modelBytes:Buffer,cacheBytes:Buffer):string {
    return createHash('sha256').update(POLICY_VERSION).update(modelBytes).update(cacheBytes).digest('hex');
  }

  /** Preserve local reports while activating a newly prepared encoder, preprocessing, adapter or publication policy. */
  needsPublication():boolean {
    if(!this.availability().ready) return false;
    const generated=resolve(this.options.generatedDirectory);
    const desired=this.inputFingerprint(readFileSync(join(generated,'learned-groups.json')),readFileSync(join(generated,'embedding-cache.json')));
    const previous=this.options.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('publication-input-fingerprint') as {value:string}|undefined;
    const latest=this.options.store.db.prepare('SELECT 1 FROM pack_versions LIMIT 1').get();
    return !latest || previous?.value!==desired;
  }

  async publish():Promise<{manifest:PackManifest;summary:unknown}> {
    const status=this.availability();
    if(!status.ready) throw new PublisherUnavailable(status.reason);
    const generated=resolve(this.options.generatedDirectory);
    const modelBytes=readFileSync(join(generated,'learned-groups.json'));const cacheBytes=readFileSync(join(generated,'embedding-cache.json'));
    const model=learnedModelSchema.parse(JSON.parse(modelBytes.toString('utf8')));
    const cache=cacheSchema.parse(JSON.parse(cacheBytes.toString('utf8')));
    const fingerprint=this.inputFingerprint(modelBytes,cacheBytes);
    if(cache.encoderVersion!==model.encoderVersion || cache.preprocessingVersion!==model.preprocessingVersion) {
      throw new PublicationRejected('Encoder cache and accepted model versions differ.');
    }
    if(model.preprocessingVersion!==PREPROCESSING_VERSION) {
      throw new PublicationRejected('Prepare the model and encoder cache with the installed description preprocessing version.');
    }
    const representations=new Map(cache.records.filter(record=>record.split==='train')
      .map(record=>[record.id,applyAdapter(record.embedding,model.adapter)]));
    const assignments=new Map<string,string>();
    const cachedIds=new Set(cache.records.map(record=>record.id));
    const cachedById=new Map(cache.records.map(record=>[record.id,record]));
    const transactions=this.options.store.all();
    for(const report of transactions) {
      // Development and test fixture families never become reference data by virtue of approval.
      if(report.reviewState!=='approved' || !report.consent.aggregateUse) continue;
      const cached=cachedById.get(report.id);
      if(cached && cached.split!=='train') continue;
      const text=preprocessDescription(report.evidenceRecord?.descriptionText??report.originalText);
      if(!text.description || text.issues.some(issue=>issue!=='long_sentence_split')) {
        // A cached source must not retain its original learned membership after a correction becomes unsupported.
        if(cached) assignments.set(report.id,'unsupported-corrected-description');
        continue;
      }
      if(cached && (!cached.descriptionText || text.description===cached.descriptionText)) continue;
      const embedding=await this.options.encodeDescription(text.description);
      const group=assignToLearnedGroup(report,embedding,model);
      if(group) {assignments.set(report.id,group);representations.set(report.id,applyAdapter(embedding,model.adapter));}
      else if(cachedIds.has(report.id)) assignments.set(report.id,'unsupported-corrected-description');
    }
    const sequence=(this.options.store.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM pack_versions').get() as {next:number}).next;
    const version=`coffee-${this.options.asOf}-v${sequence}-${randomUUID().slice(0,8)}`;
    let build:ReturnType<typeof buildComparisonPack>;
    try{build=buildComparisonPack({transactions,fxRates:this.options.fxRates,asOf:this.options.asOf,packVersion:version,
      model,additionalAssignments:assignments,representations});}
    catch(error){throw new PublicationRejected(error instanceof Error?error.message:'Aggregate publication rejected.');}
    const packsDirectory=join(resolve(this.options.dataDirectory),'packs');
    mkdirSync(packsDirectory,{recursive:true});
    const staging=join(packsDirectory,`.staging-${version}`);
    mkdirSync(staging,{recursive:false});
    for(const [filename,bytes] of build.files) writeFileSync(join(staging,filename),bytes,{flag:'wx'});
    renameSync(staging,join(packsDirectory,version));
    this.options.store.db.transaction(()=> {
      this.options.store.db.prepare('INSERT INTO pack_versions VALUES (?,?,?,?,?,?)')
        .run(version,build.manifest.cropId,build.manifest.regionId,JSON.stringify(build.manifest),new Date().toISOString(),sequence);
      const insert=this.options.store.db.prepare('INSERT INTO report_publication_membership VALUES (?,?,?,?)');
      for(const membership of build.memberships) insert.run(membership.reportId,version,membership.included?1:0,membership.reason);
      this.options.store.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('publication-input-fingerprint',fingerprint);
    })();
    return {manifest:build.manifest,summary:{synthetic:true,...build.diagnostics}};
  }
}
