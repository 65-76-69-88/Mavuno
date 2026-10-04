/**
 * Measure public installation assets with Node's native HTTP client, which does not
 * transparently decompress responses. Run after a production build and start:
 *   npx tsx scripts/measure-runtime.ts
 * Only the local demo at 127.0.0.1:3001 is contacted. Large responses stay streamed.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import { arch, platform, release, version } from 'node:os';
import path from 'node:path';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const origin = new URL('http://127.0.0.1:3001');
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const webDirectory = path.join(projectDirectory, 'dist', 'web');
const outputPath = path.join(projectDirectory, 'output', 'runtime-footprint.json');
type Category = 'shell' | 'assetRegistry' | 'modelAndRuntime' | 'comparisonPack';
type ExpectedAsset = { decodedBytes: number; sha256: string };
type Measurement = {
  category: Category; path: string; status: number; contentType: string | null;
  contentEncoding: 'identity' | 'gzip'; decodedBytes: number; wireBytes: number;
  decodedSha256: string; expectedDecodedBytes: number | null; expectedSha256: string | null;
  verified: boolean; duplicateOf?: string;
};
type Registry = {
  encoder: unknown; totalBytes: number;
  assets: { path: string; bytes: number; sha256: string }[];
};
type PublicManifest = {
  packVersion: string; policyVersion: string; preprocessingVersion: string; adapterVersion: string;
  files: { path: string; decodedBytes: number; sha256: string }[];
};

function requestPublicAsset(publicPath: string): Promise<IncomingMessage> {
  if (!publicPath.startsWith('/') || publicPath.startsWith('//')) throw new Error('Only local absolute asset paths are allowed');
  const url = new URL(publicPath, origin);
  if (url.origin !== origin.origin) throw new Error('External requests are not allowed');
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false,
      headers: { 'Accept-Encoding': 'gzip', 'Cache-Control': 'no-cache', 'User-Agent': `PriceMesh-footprint/${process.version}` },
    }, resolve);
    request.setTimeout(30_000, () => request.destroy(new Error(`HTTP request timed out: ${publicPath}`)));
    request.once('error', reject);
  });
}

/** Count encoded bytes before gunzip; validate the decoded payload hash in a bounded stream. */
async function measure(publicPath: string, category: Category, expected?: ExpectedAsset, captureLimit = 0):
Promise<{ measurement: Measurement; jsonBody?: Buffer }> {
  const response = await requestPublicAsset(publicPath);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`HTTP ${response.statusCode} for ${publicPath}; build and start the final local service first`);
  }
  const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (encoding !== 'gzip' && encoding !== 'identity') {
    response.destroy();
    throw new Error(`Unsupported content encoding ${encoding} for ${publicPath}`);
  }
  let wireBytes = 0; let decodedBytes = 0;
  const hash = createHash('sha256');
  const smallJsonChunks: Buffer[] = [];
  const encodedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) { wireBytes += chunk.length; callback(null, chunk); },
  });
  const decodedSink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      decodedBytes += chunk.length;
      hash.update(chunk);
      // Only the small public pack manifest is captured; weights and runtimes never are.
      if (captureLimit) {
        if (decodedBytes > captureLimit) { callback(new Error(`JSON response exceeded ${captureLimit} bytes`)); return; }
        smallJsonChunks.push(Buffer.from(chunk));
      }
      callback();
    },
  });
  await pipeline(response, encodedCounter, encoding === 'gzip' ? createGunzip() : new PassThrough(), decodedSink);
  const decodedSha256 = hash.digest('hex');
  if (expected && (decodedBytes !== expected.decodedBytes || decodedSha256 !== expected.sha256)) {
    throw new Error(`Served bytes do not match the built file/registry for ${publicPath}`);
  }
  const contentLength = response.headers['content-length'];
  if (contentLength !== undefined && Number(contentLength) !== wireBytes) throw new Error(`Content-Length mismatch for ${publicPath}`);
  const measurement: Measurement = {
    category, path: publicPath, status: response.statusCode,
    contentType: response.headers['content-type'] ?? null, contentEncoding: encoding,
    decodedBytes, wireBytes, decodedSha256,
    expectedDecodedBytes: expected?.decodedBytes ?? null, expectedSha256: expected?.sha256 ?? null, verified: Boolean(expected),
  };
  console.info(`${category}: ${publicPath} — ${decodedBytes} decoded / ${wireBytes} response-body bytes (${encoding})`);
  return { measurement, ...(captureLimit ? { jsonBody: Buffer.concat(smallJsonChunks) } : {}) };
}

async function builtFileExpected(publicPath: string): Promise<ExpectedAsset> {
  const localPath = path.resolve(webDirectory, `.${publicPath === '/' ? '/index.html' : publicPath}`);
  if (!localPath.startsWith(`${webDirectory}${path.sep}`)) throw new Error(`Asset path escaped build directory: ${publicPath}`);
  const file = await stat(localPath);
  const hash = createHash('sha256');
  await pipeline(createReadStream(localPath), new Writable({ write(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }));
  return { decodedBytes: file.size, sha256: hash.digest('hex') };
}

async function executableAssets(directory: string, publicPrefix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const publicPath = `${publicPrefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await executableAssets(path.join(directory, entry.name), publicPath));
    else if (/\.(?:js|css)$/.test(entry.name)) files.push(publicPath);
  }
  return files.sort();
}

function totals(files: Measurement[]) {
  return { files: files.length, decodedBytes: files.reduce((sum, file) => sum + file.decodedBytes, 0),
    wireBytes: files.reduce((sum, file) => sum + file.wireBytes, 0) };
}

async function main() {
  const registry = JSON.parse(await readFile(path.join(webDirectory, 'asset-registry.json'), 'utf8')) as Registry;
  if (!Array.isArray(registry.assets) || registry.assets.reduce((sum, asset) => sum + asset.bytes, 0) !== registry.totalBytes)
    throw new Error('Built model/runtime registry has inconsistent sizes');
  const files: Measurement[] = [];
  // The actual service-worker precache keeps both URLs, so retain their duplicated payload explicitly.
  const shellPaths = ['/', '/index.html', '/sw.js', ...await executableAssets(path.join(webDirectory, 'assets'), '/assets')];
  for (const publicPath of shellPaths) {
    const { measurement } = await measure(publicPath, 'shell', await builtFileExpected(publicPath));
    files.push(publicPath === '/' ? { ...measurement, duplicateOf: '/index.html' } : measurement);
  }
  files.push((await measure('/asset-registry.json', 'assetRegistry', await builtFileExpected('/asset-registry.json'))).measurement);
  for (const asset of registry.assets) {
    if (!/^\/(?:models|runtime)\//.test(asset.path) || !Number.isSafeInteger(asset.bytes) || !/^[a-f0-9]{64}$/.test(asset.sha256))
      throw new Error(`Invalid public registry entry: ${asset.path}`);
    const built = await builtFileExpected(asset.path);
    if (built.decodedBytes !== asset.bytes || built.sha256 !== asset.sha256) throw new Error(`Built registry mismatch: ${asset.path}`);
    files.push((await measure(asset.path, 'modelAndRuntime', { decodedBytes: asset.bytes, sha256: asset.sha256 })).measurement);
  }

  // First-use installation also downloads a pack. Show it separately from the large
  // reusable shell/model base, and also report the combined first-use payload total.
  const manifestResult = await measure('/api/packs?cropId=coffee&regionId=ondera-demo', 'comparisonPack', undefined, 65_536);
  const manifest = JSON.parse(manifestResult.jsonBody!.toString('utf8')) as PublicManifest;
  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.packVersion) || !Array.isArray(manifest.files)) throw new Error('Invalid public pack manifest');
  files.push(manifestResult.measurement);
  for (const asset of manifest.files) {
    if (!/^(?:pack\.json|adapter\.f32|prototypes\.(?:f32|i8))$/.test(asset.path) || !Number.isSafeInteger(asset.decodedBytes) || !/^[a-f0-9]{64}$/.test(asset.sha256))
      throw new Error(`Invalid public pack asset: ${asset.path}`);
    files.push((await measure(`/packs/${manifest.packVersion}/${asset.path}`, 'comparisonPack', asset)).measurement);
  }
  const initialFiles = files.filter(file => file.category !== 'comparisonPack');
  const report = {
    schemaVersion: 1, measuredAt: new Date().toISOString(), origin: origin.origin,
    environment: { operatingSystem: version(), platform: platform(), release: release(), architecture: arch(), node: process.version },
    method: {
      client: 'node:http native HTTP GET', acceptEncoding: 'gzip', wireDefinition: 'Encoded HTTP response-body bytes before decompression',
      decodedValidation: 'Asset SHA-256 and size checked against built files and model/runtime or pack registries. The API manifest hash is recorded without an independent expected hash (verified=false). Gzip streams are also checked by gunzip.',
      exclusions: ['HTTP headers and transfer framing', 'TCP/IP overhead and TLS', 'Repeated browser requests beyond the enumerated installation URLs', 'Browser cache/database overhead', 'Network timing and physical-phone measurements'],
      installationDefinition: 'One payload per shell/precache URL, the asset registry, and every registered model/runtime file. Both / and /index.html are counted because the service worker caches both URLs. The pack is shown separately and added in the combined first-use total, because app installation downloads the current pack too.',
    },
    encoder: registry.encoder,
    totals: {
      shell: totals(files.filter(file => file.category === 'shell')),
      assetRegistry: totals(files.filter(file => file.category === 'assetRegistry')),
      modelAndRuntime: totals(files.filter(file => file.category === 'modelAndRuntime')),
      initialInstallationExcludingComparisonPack: totals(initialFiles),
      separateComparisonPack: totals(files.filter(file => file.category === 'comparisonPack')),
      initialInstallationIncludingCurrentComparisonPack: totals(files),
    },
    comparisonPack: { packVersion: manifest.packVersion, policyVersion: manifest.policyVersion,
      preprocessingVersion: manifest.preprocessingVersion, adapterVersion: manifest.adapterVersion,
      excludedFromBaseInstallationSubtotal: true, downloadedDuringFirstUseInstallation: true },
    files,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`Measured installation ${report.totals.initialInstallationExcludingComparisonPack.wireBytes} response-body bytes; comparison pack ${report.totals.separateComparisonPack.wireBytes} bytes. Saved ${outputPath}`);
}

await main();
