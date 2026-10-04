let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: {vector:number[];inferenceMs:number}) => void; reject: (error: Error) => void }>();
export function encodeDescription(text: string): Promise<{vector:number[];inferenceMs:number}> {
  if (!worker) {
    worker = new Worker(new URL('./encoder.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({data}) => { const task = pending.get(data.id); if (!task) return; pending.delete(data.id); data.error ? task.reject(new Error(data.error)) : task.resolve(data); };
    worker.onerror = event => { pending.forEach(task => task.reject(new Error(event.message || 'Local model worker failed.'))); pending.clear(); worker?.terminate(); worker = undefined; };
  }
  const id = ++sequence;
  return new Promise((resolve,reject) => { pending.set(id,{resolve,reject}); worker!.postMessage({id,text}); });
}
