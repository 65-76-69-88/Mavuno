import { pipeline, env } from '@huggingface/transformers';
import { preprocessDescription } from '@pricemesh/domain';
import path from 'node:path';

export const ENCODER_VERSION = 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${path.resolve('apps/web/public/models')}${path.sep}`;
let encoder: Promise<any> | undefined;
/** Same local quantized model, prefix, sentence preparation and pooling as the browser worker. */
export async function encodeDescription(text: string): Promise<number[]> {
  const prepared = preprocessDescription(text);
  if (!prepared.chunks.length) throw new Error('No descriptive evidence to encode.');
  encoder ??= pipeline('feature-extraction', 'e5', { dtype: 'q8', device: 'cpu' }).catch(error => { encoder = undefined; throw error; });
  const model = await encoder; const mean = new Float64Array(384);
  for (const chunk of prepared.chunks) {
    const tokens = await model.tokenizer(`query: ${chunk}`, { truncation: false, padding: false });
    if (tokens.input_ids.data.length > 512) throw new Error('Description exceeds the encoder token limit.');
    const result = await model(`query: ${chunk}`, { pooling: 'mean', normalize: true });
    for (let i = 0; i < 384; i++) mean[i] += Number(result.data[i]);
  }
  const norm = Math.sqrt(mean.reduce((sum,value) => sum + value * value,0));
  if (!norm) throw new Error('Zero encoder vector.');
  return Array.from(mean, value => value / norm);
}

/** Release native inference sessions when a CLI or test no longer needs them. */
export async function disposeEncoder(): Promise<void> {
  const active = encoder;
  encoder = undefined;
  if (active) await (await active).dispose();
}
