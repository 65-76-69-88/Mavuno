import Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvidenceRecord, PrivateTransaction } from '@pricemesh/domain';
export type StoredReport=PrivateTransaction & {evidenceRecord?:EvidenceRecord};

export interface ReportStatus {
  reportId: string;
  status: 'uploaded';
  reviewState: PrivateTransaction['reviewState'];
  uploadedAt: string;
  publication: { packVersion: string; included: boolean; reason: string } | null;
}

interface ReportRow { id: string; body: string; payload_hash: string; uploaded_at: string }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonicalJson).join(',')+']';
  if (value !== null && typeof value === 'object') {
    return '{'+Object.entries(value as Record<string,unknown>).sort(([left],[right])=>left.localeCompare(right))
      .map(([key,item])=>JSON.stringify(key)+':'+canonicalJson(item)).join(',')+'}';
  }
  return JSON.stringify(value);
}

/** Private source custody. No table or JSON body is exposed by public pack routes. */
export class ReportStore {
  readonly db: Database.Database;
  private readonly tokenKey: string;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, client_report_id TEXT NOT NULL UNIQUE,
        contributor_id TEXT NOT NULL, lot_id TEXT NOT NULL,
        body TEXT NOT NULL, payload_hash TEXT NOT NULL, uploaded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id),
        private_path TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL, uploaded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id), body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_events (
        id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id),
        reviewer_id TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL,
        reviewed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contributor_reviews (
        contributor_id TEXT NOT NULL, lot_id TEXT NOT NULL, outcome TEXT NOT NULL,
        report_id TEXT NOT NULL REFERENCES reports(id),
        PRIMARY KEY(contributor_id, lot_id)
      );
      CREATE TABLE IF NOT EXISTS comparison_labels (
        left_report_id TEXT NOT NULL REFERENCES reports(id), right_report_id TEXT NOT NULL REFERENCES reports(id),
        label TEXT NOT NULL, rationale TEXT NOT NULL, reviewer_id TEXT NOT NULL, reviewed_at TEXT NOT NULL,
        PRIMARY KEY(left_report_id,right_report_id)
      );
      CREATE TABLE IF NOT EXISTS training_runs (
        id TEXT PRIMARY KEY, encoder_version TEXT NOT NULL, preprocessing_version TEXT NOT NULL,
        adapter_version TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT NOT NULL, recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pack_versions (
        version TEXT PRIMARY KEY, crop_id TEXT NOT NULL, region_id TEXT NOT NULL,
        manifest TEXT NOT NULL, published_at TEXT NOT NULL, sequence INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS report_publication_membership (
        report_id TEXT NOT NULL REFERENCES reports(id), pack_version TEXT NOT NULL REFERENCES pack_versions(version),
        included INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(report_id, pack_version)
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)')
      .run('status-token-key', randomBytes(32).toString('hex'));
    this.tokenKey = (this.db.prepare('SELECT value FROM metadata WHERE key=?').get('status-token-key') as {value:string}).value;
  }

  close(): void { this.db.close(); }

  tokenFor(id: string): string {
    return createHmac('sha256', this.tokenKey).update(id).digest('base64url');
  }

  authorizeReport(id: string, token: string): boolean {
    const expected = Buffer.from(this.tokenFor(id));
    const received = Buffer.from(token);
    return expected.length === received.length && timingSafeEqual(expected, received) && Boolean(this.find(id));
  }

  find(id: string): StoredReport | undefined {
    const row = this.db.prepare('SELECT body FROM reports WHERE id=?').get(id) as Pick<ReportRow,'body'> | undefined;
    return row ? JSON.parse(row.body) as StoredReport : undefined;
  }

  all(): StoredReport[] {
    return (this.db.prepare('SELECT body FROM reports ORDER BY uploaded_at,id').all() as Pick<ReportRow,'body'>[])
      .map(row => JSON.parse(row.body) as StoredReport);
  }

  accept(payload: Omit<StoredReport,'id'|'reviewState'|'verification'|'reviews'|'evidenceRefs'>):
      {reportId:string;statusToken:string;status:'uploaded';reviewState:PrivateTransaction['reviewState'];duplicate:boolean} {
    const payloadHash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    const existing = this.db.prepare('SELECT * FROM reports WHERE client_report_id=?').get(payload.clientReportId) as ReportRow | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new StoreConflict('This report ID was already used for different facts.');
      const report = JSON.parse(existing.body) as PrivateTransaction;
      return { reportId:report.id,statusToken:this.tokenFor(report.id),status:'uploaded',reviewState:report.reviewState,duplicate:true };
    }
    const report: StoredReport = {...payload,id:randomUUID(),reviewState:'unreviewed',verification:'seller_reported',reviews:[],evidenceRefs:[]};
    if(report.evidenceRecord) report.evidenceRecord={...report.evidenceRecord,id:report.id,reviewState:'unreviewed',verification:'seller_reported',reviews:[],attachmentRefs:[]};
    this.db.transaction(()=>this.insert(report,payloadHash))();
    return { reportId:report.id,statusToken:this.tokenFor(report.id),status:'uploaded',reviewState:'unreviewed',duplicate:false };
  }

  private insert(report: StoredReport, payloadHash: string): void {
    this.db.prepare('INSERT INTO reports(id,client_report_id,contributor_id,lot_id,body,payload_hash,uploaded_at) VALUES (?,?,?,?,?,?,?)')
      .run(report.id,report.clientReportId,report.contributorId,report.lotId,JSON.stringify(report),payloadHash,new Date().toISOString());
    this.saveObservations(report);
  }

  private saveObservations(report:StoredReport):void {
    this.db.prepare('DELETE FROM observations WHERE report_id=?').run(report.id);
    const insert=this.db.prepare('INSERT INTO observations VALUES (?,?,?)');
    for(const observation of report.evidenceRecord?.observations??[]) insert.run(`${report.id}:${observation.id}`,report.id,JSON.stringify(observation));
  }

  seed(records: PrivateTransaction[]): void {
    const transaction = this.db.transaction(() => {
      for (const report of records) {
        if (this.db.prepare('SELECT 1 FROM reports WHERE client_report_id=?').get(report.clientReportId)) continue;
        if (!report.synthetic) throw new Error('Only fictional records can seed this demo.');
        this.insert(report, 'seed');
        if (report.reviewState === 'approved' || report.reviewState === 'rejected') {
          this.db.prepare('INSERT OR IGNORE INTO contributor_reviews VALUES (?,?,?,?)')
            .run(report.contributorId,report.lotId,report.reviewState,report.id);
        }
      }
    });
    transaction();
  }

  review(id: string, outcome: PrivateTransaction['reviewState'], reason: string,
      verification?: PrivateTransaction['verification'], facts?: PrivateTransaction['facts'], evidenceRecord?:EvidenceRecord): StoredReport {
    const transaction = this.db.transaction(() => {
      const report = this.find(id);
      if (!report) throw new StoreMissing('Report not found.');
      const reviewedAt = new Date().toISOString();
      report.reviewState = outcome;
      if (verification) report.verification = verification;
      if (facts) report.facts = facts;
      if(evidenceRecord) report.evidenceRecord=evidenceRecord;
      if (outcome === 'approved' || outcome === 'rejected') {
        report.reviews.push({reviewerId:'demo-custodian',outcome:outcome==='approved'?'valid':'invalid',reviewedAt,independent:true,reason});
      }
      if(report.evidenceRecord) {
        report.evidenceRecord.reviewState=report.reviewState;
        report.evidenceRecord.verification=report.verification;
        report.evidenceRecord.reviews=report.reviews;
      }
      this.db.prepare('UPDATE reports SET body=? WHERE id=?').run(JSON.stringify(report),id);
      this.saveObservations(report);
      this.db.prepare('INSERT INTO review_events VALUES (?,?,?,?,?,?)')
        .run(randomUUID(),id,'demo-custodian',outcome,reason,reviewedAt);
      // One independent judgement per unique lot; retries and duplicate reports earn no extra credit.
      if (outcome === 'approved' || outcome === 'rejected') {
        this.db.prepare(`INSERT INTO contributor_reviews VALUES (?,?,?,?)
          ON CONFLICT(contributor_id,lot_id) DO UPDATE SET outcome=excluded.outcome, report_id=excluded.report_id`)
          .run(report.contributorId,report.lotId,outcome,id);
      } else {
        this.db.prepare('DELETE FROM contributor_reviews WHERE contributor_id=? AND lot_id=?').run(report.contributorId,report.lotId);
      }
      return report;
    });
    return transaction();
  }

  status(id: string): ReportStatus | undefined {
    const report = this.find(id);
    if (!report) return undefined;
    const row = this.db.prepare('SELECT uploaded_at FROM reports WHERE id=?').get(id) as {uploaded_at:string};
    const published = this.db.prepare(`SELECT membership.pack_version, membership.included, membership.reason
      FROM report_publication_membership membership JOIN pack_versions versions ON versions.version=membership.pack_version
      WHERE membership.report_id=? ORDER BY versions.sequence DESC LIMIT 1`).get(id) as {pack_version:string;included:number;reason:string} | undefined;
    return {reportId:id,status:'uploaded',reviewState:report.reviewState,uploadedAt:row.uploaded_at,
      publication:published ? {packVersion:published.pack_version,included:Boolean(published.included),reason:published.reason} : null};
  }

  labelComparison(leftId:string,rightId:string,label:'comparable'|'non_comparable'|'unknown',rationale:string): void {
    if (leftId===rightId) throw new StoreConflict('Choose two distinct reports for a comparison label.');
    if (!this.find(leftId) || !this.find(rightId)) throw new StoreMissing('Both source reports must exist.');
    const [left,right]=[leftId,rightId].sort();
    this.db.prepare(`INSERT INTO comparison_labels VALUES (?,?,?,?,?,?)
      ON CONFLICT(left_report_id,right_report_id) DO UPDATE SET label=excluded.label,rationale=excluded.rationale,
        reviewer_id=excluded.reviewer_id,reviewed_at=excluded.reviewed_at`)
      .run(left,right,label,rationale,'demo-custodian',new Date().toISOString());
  }

  addEvidence(id: string, file: {id:string;path:string;mimeType:string;bytes:number;sha256:string;kind:'receipt'|'photo'}): void {
    this.db.transaction(() => {
      const report = this.find(id);
      if (!report) throw new StoreMissing('Report not found.');
      this.db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?)')
        .run(file.id,id,file.path,file.mimeType,file.bytes,file.sha256,new Date().toISOString());
      report.evidenceRefs.push(file.id);
      if (file.kind === 'receipt' && report.verification === 'seller_reported') report.verification = 'receipt_attached';
      if(report.evidenceRecord) {
        report.evidenceRecord.attachmentRefs.push(file.id);
        report.evidenceRecord.verification=report.verification;
      }
      this.db.prepare('UPDATE reports SET body=? WHERE id=?').run(JSON.stringify(report),id);
    })();
  }
}

export class StoreConflict extends Error {}
export class StoreMissing extends Error {}
