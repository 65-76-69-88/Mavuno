import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runTraining } from './run-training.js';
import { generateSyntheticCorpus, syntheticRelation, GENERATOR_REVISION, PRICE_GENERATION_FORMULA } from '../fixtures/synthetic/corpus.js';
import { preprocessDescription, PREPROCESSING_VERSION } from '@pricemesh/domain';
import { encodeDescription, disposeEncoder, ENCODER_VERSION } from '../training/encoder.js';

await mkdir('generated', { recursive: true });
const corpus = generateSyntheticCorpus();
const sourceHash = createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
let existing: any;
try { existing = JSON.parse(await readFile('generated/embedding-cache.json', 'utf8')); } catch { /* first run */ }
const embeddings = new Map<string, number[]>();
if (existing?.sourceHash === sourceHash && existing.encoderVersion === ENCODER_VERSION && existing.preprocessingVersion === PREPROCESSING_VERSION) {
  for (const record of existing.records) embeddings.set(record.id, record.embedding);
}
const started = performance.now();
const records: Array<(typeof corpus.metadata)[string] & {id:string;descriptionText:string;descriptionHash:string;embedding:number[];record:(typeof corpus.records)[number]}> = [];
for (const [index, record] of corpus.records.entries()) {
  const descriptionText = preprocessDescription(record.originalText).description;
  const embedding = embeddings.get(record.id) ?? await encodeDescription(descriptionText);
  records.push({ id: record.id, descriptionText, descriptionHash: createHash('sha256').update(descriptionText).digest('hex'), embedding, ...corpus.metadata[record.id], record });
  if ((index + 1) % 16 === 0) console.log(`Embedded ${index + 1}/${corpus.records.length} private fictional records`);
}
type Triplet = {anchorId:string;positiveId:string;negativeId:string;split:string;reviewStatus:string;rationale:string};
const triplets: Triplet[] = [];
for (const split of ['train','dev','test'] as const) {
  const partition = corpus.records.filter(record => corpus.metadata[record.id]!.split === split && !corpus.metadata[record.id]!.stressType);
  for (const [anchorIndex, anchor] of partition.entries()) {
    const positives = partition.filter(record => record.lotId !== anchor.lotId && record.contributorId !== anchor.contributorId && syntheticRelation(corpus.metadata[anchor.id]!,corpus.metadata[record.id]!) === 'comparable');
    const negatives = partition.filter(record => record.lotId !== anchor.lotId && syntheticRelation(corpus.metadata[anchor.id]!,corpus.metadata[record.id]!) === 'non_comparable');
    for (let variation = 0; variation < Math.min(3, positives.length); variation++) {
      if (!negatives.length) continue;
      triplets.push({ anchorId: anchor.id, positiveId: positives[(anchorIndex + variation) % positives.length]!.id,
        negativeId: negatives[(anchorIndex * 3 + variation) % negatives.length]!.id, split,
        reviewStatus: 'synthetic_unreviewed', rationale: 'Derived from declared generator-factor similarity, with prices excluded. This is simulation truth, not independent agronomic review.' });
    }
  }
}
const labelHash = createHash('sha256').update(JSON.stringify(triplets)).digest('hex');
const cache = { schemaVersion: 1, encoderVersion: ENCODER_VERSION, preprocessingVersion: PREPROCESSING_VERSION, sourceHash, labelHash,
  generatorRevision: GENERATOR_REVISION, priceGenerationFormula: PRICE_GENERATION_FORMULA,
  records, triplets, equivalences: [], synthetic: true, independentReview: false,
  notes: ['Split contributors/lots/template families before label derivation.', 'No uncertain translations were used as equivalence training labels.', 'Repeated triplets are not independent examples.'] };
await writeFile('generated/embedding-cache.json', JSON.stringify(cache));
await writeFile('generated/split-label-manifest.json', JSON.stringify({ sourceHash, labelHash, generatorRevision: GENERATOR_REVISION,
  splits: Object.fromEntries(['train','dev','test'].map(split => [split, { records:records.filter(record => record.split === split).length,
    triplets:triplets.filter(triplet => triplet.split === split).length, contributors:new Set(records.filter(record => record.split === split).map(record => record.record.contributorId)).size }])),
  independentReview:false, synthetic:true, reviewStatus:'synthetic_unreviewed' }, null, 2));
console.log(`Actual q8 embedding cache prepared in ${((performance.now()-started)/1000).toFixed(1)} seconds; ${triplets.length} declared synthetic triplets.`);
await disposeEncoder();
await runTraining();
