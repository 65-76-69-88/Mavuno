import { preprocessDescription } from '@pricemesh/domain';

async function loadEncoder(): Promise<any> {
  // Use the publisher's pinned standalone browser bundle, served and hashed locally.
  // This avoids reprocessing the large ONNX bundle during every application build.
  const runtimeUrl = '/runtime/transformers/transformers.min.js';
  const { pipeline, env } = await import(/* @vite-ignore */ runtimeUrl) as typeof import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
  env.backends.onnx.wasm!.wasmPaths = '/runtime/onnx/';
  env.backends.onnx.wasm!.numThreads = 1;
  env.backends.onnx.wasm!.proxy = false;
  return pipeline('feature-extraction', 'e5', { dtype: 'q8', device: 'wasm' });
}
let encoder: Promise<any> | undefined;
self.onmessage = async (event: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = event.data;
  try {
    const prepared = preprocessDescription(text);
    if (!prepared.chunks.length) throw new Error('A price-free crop description is needed.');
    // A failed download or initialization can be retried after installation repairs the cache.
    encoder ??= loadEncoder().catch(error => { encoder = undefined; throw error; });
    const model = await encoder;
    const started = performance.now();
    const mean = new Float32Array(384);
    for (const chunk of prepared.chunks) {
      const tokens = await model.tokenizer(`query: ${chunk}`, { truncation: false, padding: false });
      if (tokens.input_ids.data.length > 512) throw new Error('Please shorten this description; it exceeds the encoder token limit.');
      const result = await model(`query: ${chunk}`, { pooling: 'mean', normalize: true });
      for (let i = 0; i < 384; i++) mean[i] += Number(result.data[i]);
    }
    const norm = Math.sqrt(mean.reduce((sum,value) => sum + value * value, 0));
    if (!norm) throw new Error('The encoder produced an empty representation.');
    for (let i = 0; i < 384; i++) mean[i] /= norm;
    self.postMessage({ id, vector: Array.from(mean), inferenceMs: performance.now() - started });
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
