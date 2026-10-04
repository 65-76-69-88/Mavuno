import { parseExactFacts, preprocessDescription, moneyBasisFromFacts, normalizeMoneyBasis, observationsFromDescription, isPackExpired,
  applyAdapter, decodePrototype, kernelGroupWeights, mixtureQuantiles, type SaleFacts } from '@pricemesh/domain';
import type { ClientService, InstallationState, Language, Comparison, Persona } from '../ui-contract';
import { getMeta, putMeta, getActivePack, getRecords, putRecord, type StoredRecord } from './storage';
import { downloadPack, fetchChecked, sha256, supportsManifest, ENCODER_REVISION } from './pack-loader';
import { encodeDescription } from './encoder';

type AssetRegistry = { encoder: { id: string; revision: string; dimensions: number; dtype: string }; totalBytes: number; assets: { path: string; sha256: string; bytes: number }[] };
const MODEL_CACHE = 'coffee-model-v2';
const messages = {
  en: { refused: 'More evidence is needed', compared: 'Your offer in context', installed: 'Local model and comparison pack installed', unknown: 'Please confirm the amount, charges, date and market context.', incompatible: 'This description conflicts with the installed parchment / farmgate / immediate-payment reference.', weak: 'The available description is outside the validated support of this synthetic reference.', next: 'Clarify deductions and payment timing with the buyer. The cooperative can help interpret an unusual offer.', expired: 'This reference has expired. Download a current pack or ask the cooperative.', explanation: 'Approximate median and middle 50% from nearby learned groups of reviewed fictional sales.' },
  fr: { refused: 'Plus de précisions sont nécessaires', compared: 'Votre offre en contexte', installed: 'Modèle local et données installés', unknown: 'Confirmez le montant, les frais, la date et le marché.', incompatible: 'Cette description ne correspond pas à la référence pour le café en parche vendu à la ferme avec paiement immédiat.', weak: 'La description est hors du domaine validé de cette référence synthétique.', next: 'Clarifiez les frais et le délai de paiement avec l’acheteur. Demandez conseil à la coopérative.', expired: 'Cette référence a expiré. Téléchargez des données récentes ou consultez la coopérative.', explanation: 'Médiane et milieu des 50 % approximatifs de groupes appris sur des ventes fictives vérifiées.' },
  sw: { refused: 'Maelezo zaidi yanahitajika', compared: 'Ofa yako ikilinganishwa', installed: 'Mfano wa ndani na kifurushi vimesakinishwa', unknown: 'Thibitisha kiasi, gharama, tarehe na eneo la soko.', incompatible: 'Maelezo haya yanatofautiana na kumbukumbu ya parchment, shambani, na malipo ya papo hapo.', weak: 'Maelezo hayana ushahidi wa kutosha kwa kumbukumbu hii ya kubuni.', next: 'Fafanua gharama na muda wa malipo na mnunuzi. Uliza ushirika kuhusu ofa isiyo ya kawaida.', expired: 'Kifurushi kimepitwa na muda. Pakua kipya au uliza ushirika.', explanation: 'Wastani wa kati na nusu ya kati vinakadiriwa kutoka makundi ya mauzo ya kubuni yaliyokaguliwa.' }
};
const referenceCopy = {
  en: { install: 'Install the local model and comparison pack first.', uncalibrated: 'This reference has not passed its synthetic support checks.', contradiction: 'Confirm the crop, processing and sale terms; the description gives conflicting or negated information.', money: 'The price cannot be normalized yet. Confirm quantities, currency, charges and the sale date.', cohort: 'Learned aggregate distribution', window: '90-day window', lots: 'lots', contributors: 'contributors', exclusions: ['Foreign markets and known incompatible processing, payment or delivery evidence.', 'Unreviewed, duplicate, stale or insufficiently supported sources.'], extra: ['Unknown quality is not a measured defect or grade.', 'Count bands across groups cannot be added; contributors may overlap.'] },
  fr: { install: 'Installez d’abord le modèle local et les données de comparaison.', uncalibrated: 'Cette référence n’a pas passé les contrôles de couverture synthétique.', contradiction: 'Confirmez le café, son traitement et les conditions de vente : la description est contradictoire ou négative.', money: 'Le prix ne peut pas encore être normalisé. Confirmez les quantités, la devise, les frais et la date de vente.', cohort: 'Distribution agrégée issue des groupes appris', window: 'période de 90 jours', lots: 'lots', contributors: 'contributeurs', exclusions: ['Marchés étrangers et informations incompatibles sur le traitement, le paiement ou la livraison.', 'Sources non vérifiées, en double, anciennes ou insuffisamment étayées.'], extra: ['Une qualité inconnue n’est ni un défaut mesuré ni un grade.', 'Les fourchettes de nombre ne s’additionnent pas : un contributeur peut figurer dans plusieurs groupes.'] },
  sw: { install: 'Sakinisha kwanza mfano wa ndani na kifurushi cha kulinganisha.', uncalibrated: 'Kumbukumbu hii haijapita ukaguzi wa ushahidi wa kubuni.', contradiction: 'Thibitisha kahawa, uchakataji na masharti ya mauzo; maelezo yanatoa taarifa zinazokinzana au zilizokanushwa.', money: 'Bei haiwezi kukokotolewa bado. Thibitisha kiasi, sarafu, gharama na tarehe ya mauzo.', cohort: 'Mgawanyo wa makundi yaliyojifunzwa', window: 'kipindi cha siku 90', lots: 'mafungu', contributors: 'wachangiaji', exclusions: ['Masoko ya nje na ushahidi usiolingana wa uchakataji, malipo au utoaji.', 'Vyanzo visivyokaguliwa, vinavyojirudia, vya zamani au visivyo na ushahidi wa kutosha.'], extra: ['Ubora usiojulikana si kasoro iliyopimwa wala daraja.', 'Idadi za makundi hazijumlishwi; mchangiaji anaweza kuwa katika makundi mengi.', 'Maneno ya kilimo ya Kiswahili hayajakaguliwa na mtaalamu huru wa lugha.'] }
};
const disclosureTranslations: Record<string, { fr: string; sw: string }> = {
  'All source sales and prices are fictional.': { fr: 'Toutes les ventes et tous les prix sont fictifs.', sw: 'Mauzo na bei zote za chanzo ni za kubuni.' },
  'Coarse distributions are an approximation of the private reference.': { fr: 'Les distributions regroupées sont une approximation de la référence privée.', sw: 'Mgawanyo uliowekwa katika makundi unakadiria kumbukumbu ya faragha.' },
  'Aggregation is not a formal anonymity guarantee.': { fr: 'L’agrégation ne garantit pas formellement l’anonymat.', sw: 'Kukusanya taarifa katika makundi hakuhakikishi kutotambulika.' },
  'Reported characteristics are not certified quality measurements.': { fr: 'Les caractéristiques déclarées ne sont pas des mesures de qualité certifiées.', sw: 'Sifa zilizoripotiwa si vipimo vya ubora vilivyothibitishwa.' }
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
function refusal(language: Language, explanation: string, outcome: 'clarify' | 'abstain' = 'clarify'): Comparison {
  return { outcome, title: messages[language].refused, explanation, nextStep: explanation, limitations: [], exclusions: [], coverage: [] };
}
async function installationState(): Promise<InstallationState> {
  const marker = await getMeta<InstallationState>('installation');
  if (!marker?.ready) return marker ?? { ready: false, phase: 'Install the local model to compare offline.', progress: 0 };
  const active = await getActivePack();
  if (active && !supportsManifest(active.manifest)) return { ready: false, phase: 'Refresh the comparison pack for this application version.', progress: 0 };
  const registry = await getMeta<AssetRegistry>('registry');
  const cache = await caches.open(MODEL_CACHE);
  if (!registry || !active || registry.encoder.revision !== ENCODER_REVISION || !(await Promise.all(registry.assets.map(asset => cache.match(asset.path)))).every(Boolean)) return { ready: false, phase: 'Local assets were evicted or changed. Reinstall to compare offline.', progress: 0 };
  return marker;
}
async function install(onProgress: (state: InstallationState) => void): Promise<void> {
  const state: InstallationState = { ready: false, phase: 'Preparing offline installation', progress: 0, downloadedBytes: 0 };
  const emit = async () => { onProgress({ ...state }); await putMeta('installation', { ...state }); };
  try {
    if (import.meta.env.DEV) throw new Error('Offline installation uses the production build. Run npm run build, then npm start and open localhost:3001.');
    if (!('serviceWorker' in navigator)) throw new Error('This browser does not support offline installation.');
    await emit();
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    // Control is not required to install: assets go straight into Cache Storage, and the next normal
    // page load is controlled. A hard-reloaded page (Ctrl+Shift+R) is never controlled, so only wait briefly.
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 3000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    const registry = await (await fetchChecked('/asset-registry.json')).json() as AssetRegistry;
    if (!Array.isArray(registry.assets) || !registry.assets.length) throw new Error('Model assets have not been fetched on the server.');
    if (registry.encoder.id !== 'Xenova/multilingual-e5-small' || registry.encoder.revision !== ENCODER_REVISION || registry.encoder.dimensions !== 384 || registry.encoder.dtype !== 'q8') throw new Error('The available model assets are incompatible with this application.');
    state.totalBytes = registry.totalBytes;
    const cache = await caches.open(MODEL_CACHE);
    for (const asset of registry.assets) {
      if (!/^\/(?:models\/e5\/|runtime\/onnx\/|runtime\/transformers\/)/.test(asset.path) || asset.path.includes('..')) throw new Error('Invalid asset registry path.');
      state.phase = `Checking ${asset.path.split('/').at(-1)}`; await emit();
      let response = await cache.match(asset.path);
      if (!response || await sha256(await response.clone().arrayBuffer()) !== asset.sha256) {
        response = await fetchChecked(asset.path);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error(`Model asset integrity failure: ${asset.path}`);
        // Cache the verified bytes rather than a second tee of the (compressed, streamed) network body,
        // which Chrome rejects for large assets with "Cache.put() encountered a network error".
        await cache.put(asset.path, new Response(bytes, { headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } }));
      }
      state.downloadedBytes! += asset.bytes; state.progress = Math.min(92, 92 * state.downloadedBytes! / registry.totalBytes); await emit();
    }
    await cache.put('/asset-registry.json', new Response(JSON.stringify(registry), { headers: { 'Content-Type': 'application/json' } }));
    await putMeta('registry', registry);
    state.phase = 'Validating the aggregate pack'; state.progress = 94; await emit();
    await downloadPack();
    state.phase = 'Running a new inference with the installed local assets'; state.progress = 97; await emit();
    await encodeDescription('Dry Arabica parchment coffee stored in clean sacks and collected at the farm.');
    await navigator.storage?.persist?.();
    state.ready = true; state.progress = 100; state.phase = 'Local assets verified. Ready for offline comparison.'; await emit();
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); state.phase = 'Installation incomplete'; await emit(); throw error; }
}
async function compare(facts: SaleFacts, narrative: string, language: Language): Promise<Comparison> {
  const copy = referenceCopy[language];
  const active = await getActivePack();
  if (!active || !(await installationState()).ready) return refusal(language, copy.install, 'abstain');
  if (isPackExpired(active.pack.validUntil, today())) return refusal(language, messages[language].expired, 'abstain');
  if (active.pack.calibration.status !== 'passed') return refusal(language, copy.uncalibrated, 'abstain');
  const needed = [facts.cropId, facts.marketAreaId, facts.saleDate, facts.saleChannel];
  if (needed.some(value => value.value === null || !['confirmed','attested'].includes(value.status))) return refusal(language, messages[language].unknown);
  if (facts.cropId.value !== active.pack.cropId || facts.marketAreaId.value !== active.pack.regionId || facts.saleChannel.value !== active.pack.scope.marketTier) return refusal(language, messages[language].incompatible, 'abstain');
  const money = moneyBasisFromFacts(facts);
  if (!money) return refusal(language, messages[language].unknown);
  const normalized = normalizeMoneyBasis(money, facts.saleDate.value!, active.pack.referenceCurrency, active.pack.fxRates);
  if (!normalized.ok) return refusal(language, copy.money);
  const prepared = preprocessDescription(narrative);
  const semanticIssues = parseExactFacts(prepared.description).clarifications.filter(issue => ['species', 'productForm', 'deliveryTerms', 'paymentTerms'].includes(issue.field));
  if (semanticIssues.length) return refusal(language, copy.contradiction);
  if (prepared.description.split(/\s+/).length < 5 || prepared.issues.includes('description_missing')) return refusal(language, messages[language].weak);
  const incompatible = (group: typeof active.pack.groups[number]) => (['species','productForm','deliveryTerms','paymentTerms'] as const).some(key => facts[key].value && group.context[key] && facts[key].value !== group.context[key]);
  const groups = active.pack.groups.filter(group => !incompatible(group));
  if (!groups.length) return refusal(language, messages[language].incompatible, 'abstain');
  const encoded = await encodeDescription(prepared.description);
  const adapter = Array.from({ length: 384 }, (_,i) => new DataView(active.adapter).getFloat32(i * 4, true));
  const vector = applyAdapter(encoded.vector, adapter);
  const scored = groups.map(group => ({ ...group, vector: decodePrototype(active.prototypes, group, active.manifest.vectorEncoding) }));
  const weights = kernelGroupWeights(vector, scored, active.pack.calibration.kernelTemperature, active.pack.calibration.maxDistance);
  if (!weights.length) return refusal(language, messages[language].weak, 'abstain');
  const weightedGroups = weights.map(weight => ({ weight: weight.weight, group: groups.find(group => group.id === weight.id)! }));
  const quantiles = mixtureQuantiles(weightedGroups.map(({weight,group}) => ({weight,distribution:group.distribution})));
  const offer = Number(normalized.value.netCropPrice); const median = Number(quantiles.q50);
  return { outcome: 'compared', title: messages[language].compared, explanation: messages[language].explanation,
    nextStep: messages[language].next, median, q25: Number(quantiles.q25), q75: Number(quantiles.q75), offer,
    deltaPct: 100 * (offer - median) / median, currency: active.pack.referenceCurrency,
    cashReceived: normalized.value.settlementCash === null ? undefined : Number(normalized.value.settlementCash),
    inferenceMs: encoded.inferenceMs, packVersion: active.pack.packVersion, observationWindow: `${active.pack.asOf} · ${copy.window}`,
    cohortLabel: copy.cohort,
    coverage: weightedGroups.map(({ group }) => `${group.countBands.lots.min}–${group.countBands.lots.max} ${copy.lots}; ${group.countBands.contributors.min}–${group.countBands.contributors.max} ${copy.contributors} (${group.id})`),
    exclusions: copy.exclusions,
    limitations: [...active.pack.disclosure.limitations.map(text => language === 'en' ? text : disclosureTranslations[text]?.[language] ?? text), ...copy.extra] };
}
async function saveSale(persona: Persona, sale: Parameters<ClientService['saveSale']>[1]): Promise<StoredRecord> {
  if (sale.attachment && (sale.attachment.size > 5 * 1024 * 1024 || !['image/png','image/jpeg'].includes(sale.attachment.type))) throw new Error('Attach a PNG or JPEG no larger than 5 MB.');
  const record: StoredRecord = { id: crypto.randomUUID(), persona, facts: structuredClone(sale.facts), description: sale.description, language: sale.language, consent: sale.consent,
    lotDescription: sale.lotDescription, createdAt: new Date().toISOString(), outbox: sale.consent.upload ? 'queued' : 'local', reviewState: 'unreviewed',
    attachment: sale.attachment, attachmentName: sale.attachment?.name };
  await putRecord(record); return record;
}
const syncing = new Map<Persona, Promise<void>>();
async function performSync(persona: Persona): Promise<void> {
  if (!navigator.onLine) throw new Error('Reconnect to upload or check review status. Your records remain saved locally.');
  for (const record of await getRecords(persona)) {
    if (!record.consent.upload || record.outbox === 'local') continue;
    try {
      if (record.outbox !== 'uploaded') {
        record.outbox = 'uploading'; record.error = undefined; await putRecord(record);
        const correctedDescription = preprocessDescription(record.lotDescription ?? record.description).description;
        const contextConfirmed = [record.facts.cropId,record.facts.marketAreaId,record.facts.saleDate,record.facts.saleChannel].every(field => field.value !== null && ['confirmed','attested'].includes(field.status));
        const evidenceRecord = {
          id: record.id, clientReportId: record.id, lotId: `lot-${record.id}`, contributorId: persona,
          custodianId: 'fictional-demo-cooperative', rawText: record.description, language: record.language,
          attachmentRefs: [], observations: observationsFromDescription(correctedDescription), money: moneyBasisFromFacts(record.facts),
          context: { cropId: record.facts.cropId.value ?? undefined, marketAreaId: record.facts.marketAreaId.value ?? undefined,
            date: record.facts.saleDate.value ?? undefined, marketTier: record.facts.saleChannel.value ?? undefined,
            status: contextConfirmed ? 'confirmed' : 'proposed', sourceRefs: ['user-confirmation'] },
          descriptionText: correctedDescription, consent: { ...record.consent, recordedAt: record.createdAt }, reviewState: 'unreviewed', synthetic: true
        };
        const response = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evidenceRecord) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed');
        record.reportId = result.reportId; record.statusToken = result.statusToken; record.outbox = 'uploaded'; await putRecord(record);
      }
      if (record.attachment && !record.attachmentUploaded) {
        const data = new FormData(); data.append('file', record.attachment, record.attachmentName ?? 'evidence.png'); data.append('kind', 'photo');
        const response = await fetch(`/api/reports/${record.reportId}/evidence`, { method: 'POST', headers: { Authorization: `Bearer ${record.statusToken}` }, body: data });
        if (!response.ok) throw new Error('The sale uploaded, but the private attachment needs retry.');
        record.attachmentUploaded = true;
      }
      const statusResponse = await fetch(`/api/reports/${record.reportId}/status`, { headers: { Authorization: `Bearer ${record.statusToken}` }, cache: 'no-store' });
      const status = await statusResponse.json(); if (!statusResponse.ok) throw new Error(status.error || 'Status unavailable.');
      record.reviewState = status.reviewState; record.includedVersion = status.publication?.included ? status.publication.packVersion : undefined;
      record.error = undefined; await putRecord(record);
    } catch (error) { if (record.outbox === 'uploading') record.outbox = 'queued'; record.error = error instanceof Error ? error.message : String(error); await putRecord(record); }
  }
}
export const client: ClientService = {
  async snapshot(persona) { const pack = await getActivePack(); return { installation: await installationState(), records: await getRecords(persona), pack: pack ? { version: pack.manifest.packVersion, asOf: pack.manifest.asOf, validUntil: pack.manifest.validUntil, bytes: pack.manifest.files.reduce((sum,file) => sum + file.decodedBytes,0), lastUpdated: pack.installedAt } : undefined }; },
  install,
  async interpret(text, language) { const parsed = parseExactFacts(text, { language, offerDate: today(), context: { cropId: 'coffee', marketAreaId: 'ondera-demo', saleChannel: 'farmgate' } }); return { facts: parsed.facts, lotDescription: parsed.priceFreeNarrative, issues: parsed.clarifications.map(issue => issue.question) }; },
  compare, saveSale,
  async sync(persona) { let task = syncing.get(persona); if (!task) { task = performSync(persona).finally(() => syncing.delete(persona)); syncing.set(persona, task); } await task; },
  async updatePack() { const result = await downloadPack(); return { updated: result.updated, version: result.active.manifest.packVersion }; }
};
