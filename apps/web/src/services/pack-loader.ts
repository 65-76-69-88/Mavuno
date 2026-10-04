import { packManifestSchema, comparisonPackSchema, PREPROCESSING_VERSION, decodeAdapter } from '@pricemesh/domain';
import { activatePack, getActivePack } from './storage';
import type { ActivePack } from './storage';
import type { PackManifest } from '@pricemesh/domain';

export const ENCODER_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export function supportsManifest(manifest: PackManifest): boolean {
  return manifest.schemaVersion === 2 && manifest.cropId === 'coffee' && manifest.regionId === 'ondera-demo'
    && manifest.synthetic && manifest.dimensions === 384
    && manifest.encoderVersion === `Xenova/multilingual-e5-small@${ENCODER_REVISION}:q8`
    && manifest.preprocessingVersion === PREPROCESSING_VERSION;
}
export async function sha256(bytes: ArrayBuffer): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join(''); }
export async function fetchChecked(url: string): Promise<Response> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  return response;
}
export async function downloadPack(): Promise<{ updated: boolean; active: ActivePack }> {
  const manifest = packManifestSchema.parse(await (await fetchChecked('/api/packs?cropId=coffee&regionId=ondera-demo')).json());
  if (!supportsManifest(manifest)) throw new Error('This pack is incompatible with the installed model or demo profile.');
  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.packVersion)) throw new Error('Invalid pack version.');
  const previous = await getActivePack();
  if (previous?.manifest.packVersion === manifest.packVersion) return { updated: false, active: previous };
  if (manifest.files.length !== 3 || new Set(manifest.files.map(file => file.path)).size !== 3) throw new Error('A pack must contain exactly its JSON, adapter and prototype assets.');
  const files = new Map<string, ArrayBuffer>();
  // All files are staged privately in memory before the single IndexedDB activation.
  for (const asset of manifest.files) {
    if (asset.decodedBytes > 1024 * 1024) throw new Error('Pack asset exceeds the prototype size limit.');
    const bytes = await (await fetchChecked(`/packs/${manifest.packVersion}/${asset.path}`)).arrayBuffer();
    if (bytes.byteLength !== asset.decodedBytes || await sha256(bytes) !== asset.sha256) throw new Error(`Pack integrity check failed for ${asset.path}; the previous version remains installed.`);
    files.set(asset.path, bytes);
  }
  const json = files.get('pack.json'); const adapter = files.get('adapter.f32');
  const prototypes = files.get(manifest.vectorEncoding === 'int8' ? 'prototypes.i8' : 'prototypes.f32');
  if (!json || !adapter || !prototypes || adapter.byteLength !== 384 * 4) throw new Error('Incomplete comparison pack.');
  const pack = comparisonPackSchema.parse(JSON.parse(new TextDecoder().decode(json)));
  if (pack.packVersion !== manifest.packVersion || pack.cropId !== manifest.cropId || pack.regionId !== manifest.regionId || pack.asOf !== manifest.asOf || pack.validUntil !== manifest.validUntil || pack.referenceBasis !== manifest.referenceBasis) throw new Error('Manifest and pack metadata disagree.');
  const stride = 384 * (manifest.vectorEncoding === 'int8' ? 1 : 4);
  if (pack.groups.some(group => group.vector.byteOffset + stride > prototypes.byteLength || group.vector.byteOffset % stride !== 0 || (manifest.vectorEncoding === 'int8' && !group.vector.scale))) throw new Error('Invalid prototype offsets.');
  decodeAdapter(adapter);
  const active = { manifest, pack, adapter, prototypes, installedAt: new Date().toISOString() };
  await activatePack(active);
  return { updated: true, active };
}
