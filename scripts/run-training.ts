import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The CPU trainer is a build-time tool; it never runs on the request path. */
export async function runTraining(args: string[] = []): Promise<void> {
  const python = process.env.TRAINING_PYTHON || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const trainer = spawn(python, ['training/train.py', ...args], { stdio: 'inherit' });
  const code = await new Promise<number>((resolve, reject) => {
    trainer.once('error', reject);
    trainer.once('exit', value => resolve(value ?? 1));
  });
  if (code) throw new Error(`CPU training exited with status ${code}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runTraining(process.argv.slice(2));
}
