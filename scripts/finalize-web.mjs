import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const assets = (await readdir('dist/web/assets')).filter(file => /\.(js|css)$/.test(file)).map(file => `/assets/${file}`);
const buildId = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0,12);
const source = await readFile('apps/web/public/sw.js','utf8');
await writeFile('dist/web/sw.js', source.replace('__SHELL_ASSETS__', JSON.stringify(['/', '/index.html', ...assets])).replace('__BUILD_ID__', buildId));
