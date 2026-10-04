import { spawn } from 'node:child_process';
import { config } from 'dotenv';
config();
const processes = [spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' })];
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { processes.forEach(child => child.kill()); process.exit(); });
for (const child of processes) child.on('exit', code => { if (code) { processes.forEach(other => other.kill()); process.exit(code); } });
