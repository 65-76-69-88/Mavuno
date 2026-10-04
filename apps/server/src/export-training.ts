/** Local custodian export: never served by Express, never placed under web public assets. */
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ReportStore } from './store.js';

config({quiet:true});
const output=resolve(process.argv[2]??'generated/reviewer-training-input.json');
for(const directory of ['apps/web/public','dist/web']) {
  const publicRoot=resolve(directory).toLowerCase();
  if(output.toLowerCase()===publicRoot || output.toLowerCase().startsWith(publicRoot+sep)) throw new Error('Private training exports must stay outside browser assets.');
}
const store=new ReportStore(resolve(process.env.DATA_DIR??'data','reports.sqlite'));
try {
  const records=store.all().filter(record=>record.synthetic && record.consent.upload && record.consent.aggregateUse && record.reviewState==='approved');
  const approvedIds=new Set(records.map(record=>record.id));
  const labels=store.db.prepare('SELECT * FROM comparison_labels ORDER BY reviewed_at,left_report_id,right_report_id').all() as {
    left_report_id:string;right_report_id:string;label:string;rationale:string;reviewer_id:string;reviewed_at:string}[];
  const eligibleLabels=labels.filter(label=>approvedIds.has(label.left_report_id) && approvedIds.has(label.right_report_id));
  const snapshot={schemaVersion:1,synthetic:true,exportedAt:new Date().toISOString(),records,
    comparisons:eligibleLabels.filter(label=>label.label!=='unknown'),clarificationOnly:eligibleLabels.filter(label=>label.label==='unknown'),
    trainingState:'requires_frozen_split_and_reproducible_development_cli',
    notes:['This private synthetic snapshot is an input queue, not an accepted training run.',
      'Freeze contributor/lot/scenario/template splits before triplet derivation; never move original held-out fixtures into training.',
      'Unknown labels remain clarification cases and are excluded from triplet training.',
      'Review labels and rationale without amounts or contributor identities.']};
  const bytes=Buffer.from(JSON.stringify(snapshot));
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,bytes);
  console.info(JSON.stringify({records:records.length,comparisons:snapshot.comparisons.length,clarificationOnly:snapshot.clarificationOnly.length,
    decodedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
} finally {store.close();}
