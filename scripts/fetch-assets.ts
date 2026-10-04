import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// An immutable Hub commit, verified through the publisher's public model API.
export const MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const publicRoot = path.resolve('apps/web/public');
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];
type Asset = { path: string; sha256: string; bytes: number; source: string; license: string; purpose: string };
const assets: Asset[] = [];

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
let previous: { assets: Asset[] } | undefined;
try { previous = JSON.parse(await readFile(path.join(publicRoot, 'asset-registry.json'), 'utf8')); } catch { /* first installation */ }
for (const file of modelFiles) {
  const url = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${MODEL_REVISION}/${file}`;
  const target = path.join(publicRoot, 'models/e5', file);
  await mkdir(path.dirname(target), { recursive: true });
  const existing = previous?.assets.find(asset => asset.path === `/models/e5/${file}`);
  let valid = false;
  try { valid = Boolean(existing && await digest(target) === existing.sha256); } catch { /* absent file */ }
  if (!valid) {
    console.log(`Downloading ${file} from immutable model revision ${MODEL_REVISION}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Asset download failed: ${file} (${response.status})`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(`${target}.partial`));
    await rename(`${target}.partial`, target);
  }
  assets.push({ path: `/models/e5/${file}`, sha256: await digest(target), bytes: (await stat(target)).size,
    source: url, license: 'MIT (intfloat base model; Xenova ONNX conversion)', purpose: 'local multilingual semantic encoder' });
}
const runtimeRoot = path.resolve('node_modules/onnxruntime-web/dist');
const { readdir } = await import('node:fs/promises');
for (const file of (await readdir(runtimeRoot)).filter(file => /^ort-wasm.*\.(wasm|mjs)$/.test(file))) {
  const target = path.join(publicRoot, 'runtime/onnx', file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(runtimeRoot, file), target);
  assets.push({ path: `/runtime/onnx/${file}`, sha256: await digest(target), bytes: (await stat(target)).size,
    source: 'npm:onnxruntime-web (exact version in package-lock.json)', license: 'MIT', purpose: 'offline WASM runtime' });
}
await mkdir('generated', { recursive: true });
const transformerBundle = path.join(publicRoot, 'runtime/transformers/transformers.min.js');
await mkdir(path.dirname(transformerBundle), { recursive: true });
await copyFile('node_modules/@huggingface/transformers/dist/transformers.min.js', transformerBundle);
assets.push({ path: '/runtime/transformers/transformers.min.js', sha256: await digest(transformerBundle), bytes: (await stat(transformerBundle)).size,
  source: 'npm:@huggingface/transformers@3.8.1/dist/transformers.min.js', license: 'Apache-2.0', purpose: 'pinned standalone browser inference runtime' });
const registry = {
  schemaVersion: 1, encoder: { id: 'Xenova/multilingual-e5-small', revision: MODEL_REVISION, dimensions: 384, dtype: 'q8', prefix: 'query: ' },
  accessedAt: new Date().toISOString(), licenseSources: ['https://huggingface.co/intfloat/multilingual-e5-small', `https://huggingface.co/Xenova/multilingual-e5-small/blob/${MODEL_REVISION}/README.md`],
  languages: ['en', 'fr', 'sw'], knownGaps: ['No physical-phone measurements', 'Kiswahili agricultural review unavailable', 'Initial model installation needs assisted broadband access'],
  assets, totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0)
};
await writeFile(path.join(publicRoot, 'asset-registry.json'), JSON.stringify(registry, null, 2));
await writeFile('generated/asset-registry.json', JSON.stringify(registry, null, 2));
console.log(`Verified ${assets.length} local assets, ${(registry.totalBytes / 1024 / 1024).toFixed(2)} MiB. Registry contains actual SHA-256 hashes.`);
