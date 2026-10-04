import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { learnedModelSchema } from '@pricemesh/pack';

const source=path.resolve('generated');
const output=path.resolve('artifacts/synthetic');
const files=['learned-groups.json','embedding-cache.json','training-report.json','split-label-manifest.json','candidate-adapter.f32'];
const model=learnedModelSchema.parse(JSON.parse(await readFile(path.join(source,'learned-groups.json'),'utf8')));
const cache=JSON.parse(await readFile(path.join(source,'embedding-cache.json'),'utf8')) as {synthetic?:boolean;encoderVersion:string;preprocessingVersion:string;
  records:{id:string;split:string;record:{synthetic?:boolean}}[]};
if(cache.synthetic!==true || !cache.records.every(record=>record.record.synthetic===true)) throw new Error('Only fictional source artifacts can be packaged for this demo.');
if(cache.encoderVersion!==model.encoderVersion || cache.preprocessingVersion!==model.preprocessingVersion) throw new Error('Model and embedding cache versions differ.');
const trainingIds=new Set(cache.records.filter(record=>record.split==='train').map(record=>record.id));
if(model.groups.some(group=>group.memberIds.some(id=>!trainingIds.has(id)))) throw new Error('A held-out or absent record entered a publication group.');
await mkdir(output,{recursive:true});
const registry=[];
for(const file of files) {
  const bytes=await readFile(path.join(source,file));
  await copyFile(path.join(source,file),path.join(output,file));
  registry.push({path:file,decodedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
    purpose:'synthetic server publication and reproducibility; never served as a browser asset',synthetic:true});
}
await writeFile(path.join(output,'artifact-manifest.json'),JSON.stringify({schemaVersion:1,synthetic:true,
  encoderVersion:model.encoderVersion,preprocessingVersion:model.preprocessingVersion,adapterVersion:model.adapterVersion,
  trainingStatus:model.trainingStatus,files:registry,limitations:['The synthetic embedding cache contains individual fictional source records and must remain outside the web static directory.',
    'No foundation-model weights are included. Fetch the pinned local encoder separately.','Python/PyTorch is needed to reproduce training, not to run the published service.']},null,2));
await writeFile(path.join(output,'README.md'),`# Synthetic server artifacts\n\nThese deterministic fictional records, cached embeddings and learned groups allow the Node publishing service to start without Python. They are server inputs, not the downloaded public comparison pack. Express serves only validated aggregate pack files from the private data directory; this artifact folder is outside the browser static tree.\n\nRun \`npm run assets:prepare\` to reproduce the training experiment, then \`npm run release:package\` to refresh this snapshot. Fetch the separately pinned encoder with \`npm run assets:fetch\`. The registry records the exact byte hashes and sizes.\n\nTraining status: **${model.trainingStatus}**. Labels, sales, prices and attestations are synthetic. The training report retains baseline and held-out failures; no field accuracy or farmer outcome is claimed.\n`);
console.info(`Packaged ${registry.length} synthetic server artifacts (${registry.reduce((sum,file)=>sum+file.decodedBytes,0)} bytes).`);
