import { build } from 'esbuild';
await build({ entryPoints: ['apps/server/src/index.ts'], outfile: 'dist/server/index.js', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', alias: { '@pricemesh/domain': './packages/domain/src/index.ts', '@pricemesh/pack': './packages/pack/src/index.ts' } });
