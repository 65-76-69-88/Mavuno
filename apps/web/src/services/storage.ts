import { openDB, type DBSchema } from 'idb';
import type { PersonalRecord } from '../ui-contract';
import type { ComparisonPack, PackManifest } from '@pricemesh/domain';

export interface ActivePack {
  manifest: PackManifest; pack: ComparisonPack; adapter: ArrayBuffer; prototypes: ArrayBuffer; installedAt: string;
}
export interface StoredRecord extends PersonalRecord {
  persona: string; lotDescription?: string; reportId?: string; statusToken?: string; attachment?: Blob; attachmentName?: string; attachmentUploaded?: boolean;
}
interface LocalDatabase extends DBSchema {
  meta: { key: string; value: unknown };
  records: { key: string; value: StoredRecord; indexes: { persona: string } };
}
const database = openDB<LocalDatabase>('coffee-companion-v2', 1, {
  upgrade(db) { db.createObjectStore('meta'); const records = db.createObjectStore('records', { keyPath: 'id' }); records.createIndex('persona', 'persona'); }
});
export async function getMeta<T>(key: string): Promise<T | undefined> { return (await database).get('meta', key) as Promise<T | undefined>; }
export async function putMeta(key: string, value: unknown): Promise<void> { await (await database).put('meta', value, key); }
export async function activatePack(pack: ActivePack): Promise<void> {
  const db = await database; const tx = db.transaction('meta', 'readwrite');
  const previous = await tx.store.get('active-pack');
  if (previous) await tx.store.put(previous, 'previous-pack');
  await tx.store.put(pack, 'active-pack');
  await tx.done;
}
export async function getActivePack(): Promise<ActivePack | undefined> { return getMeta<ActivePack>('active-pack'); }
export async function getRecords(persona: string): Promise<StoredRecord[]> { return (await (await database).getAllFromIndex('records', 'persona', persona)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
export async function putRecord(record: StoredRecord): Promise<void> { await (await database).put('records', record); }
