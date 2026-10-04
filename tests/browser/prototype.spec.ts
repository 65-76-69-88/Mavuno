import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { encodeDescription as encodeOnNode, disposeEncoder, ENCODER_VERSION } from '../../training/encoder.js';

const secret = process.env.REVIEWER_SECRET || 'synthetic-browser-test-reviewer';
const output = 'output/browser';
const english = 'I have 50 kg of dry Arabica parchment coffee, carefully hand-sorted and kept in clean sacks in Ondera-Demo. The buyer collects from the farm and pays immediately. The offer is TZS 4800 per kg on 2026-10-04. Sale costs are 0 and loan repayment is 0.';
const french = 'Je vends 50 kg de café Arabica en parche, trié à la main et conservé au sec dans des sacs propres à Ondera-Demo. L’acheteur vient chercher à la ferme et paie immédiatement. L’offre est de 4800 TZS par kg le 2026-10-04. Les frais de vente sont 0 et le remboursement du prêt est 0.';
const kiswahili = 'Nina kilo 50 za kahawa ya Arabika parchment iliyochambuliwa kwa mkono na kuhifadhiwa kwenye magunia safi huko Ondera-Demo. Mnunuzi anachukua shambani na analipa mara moja. Ofa ni TZS 4800 kwa kilo tarehe 2026-10-04. Gharama za mauzo ni 0 na malipo ya deni ni 0.';

test.afterAll(async () => { await disposeEncoder(); });

async function confirmAndCompare(page: Page) {
  const charges = page.getByLabel('Sale charges (whole lot)', { exact: true });
  if (!await charges.inputValue()) await charges.fill('0');
  await page.getByLabel('These are the details I want to compare.').check();
  await page.getByRole('button', { name: 'Confirm and compare' }).click();
  await expect(page.getByRole('heading', { name: 'Your offer in context' })).toBeVisible({ timeout: 90_000 });
}

test('genuine local inference survives offline reload; personal records and contribution loop stay separate', async ({ page, context, request, browser }) => {
  test.setTimeout(360_000);
  mkdirSync(output, { recursive: true });
  const unexpectedCalls: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const sourceMarker = `browser-${Date.now()}`;
  const timings: Record<string, number> = {};
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', outgoing => {
    const url = outgoing.url();
    if (url.startsWith('http') && new URL(url).origin !== 'http://127.0.0.1:3001') unexpectedCalls.push(url);
  });
  const unauthorized = await request.get('/api/reviewer/reports');
  expect(unauthorized.status()).toBe(401);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What are you selling?' })).toBeVisible();
  const installStarted = performance.now();
  await page.getByRole('button', { name: 'Install offline assets' }).click();
  await expect(page.getByText('Offline assets installed', { exact: true })).toBeVisible({ timeout: 180_000 });
  timings.installUiMs = performance.now() - installStarted;
  expect(unexpectedCalls).toEqual([]);
  const receiptPage = await context.newPage();
  await receiptPage.setContent(`<html><body style="margin:0;background:#f4f3eb;font:17px system-ui"><article id="receipt" style="margin:20px;background:white;padding:32px;width:410px;border:1px solid #bbb"><h1 style="font-size:25px">Fictional sale receipt</h1><p>Browser-test evidence only</p><hr><p>Date: 2026-10-04</p><p>Coffee: Arabica parchment</p><p>Weight: 50 kg</p><p>Crop amount: TZS 260,000</p><p>Sale charges: TZS 0</p><p>Loan settlement: TZS 0</p><p>Buyer collects; immediate payment.</p><hr><p style="font-size:12px">Receipt id: ${sourceMarker}</p><p style="font-size:12px">This is synthetic evidence, not a real payment record.</p></article></body></html>`);
  const evidencePng = await receiptPage.locator('#receipt').screenshot({ path: `${output}/synthetic-receipt.png` });
  await receiptPage.close();

  // Failed updates must leave the previous active pack in IndexedDB.
  const installedManifest = await (await request.get('/api/packs?cropId=coffee&regionId=ondera-demo')).json();
  const manifestPattern = '**/api/packs?*';
  await context.route(manifestPattern, route => route.fulfill({ json: { ...installedManifest, packVersion: 'incompatible-test', preprocessingVersion: 'unsupported-preprocessing' } }));
  await page.getByRole('button', { name: 'Check for an update', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('incompatible');
  await expect(page.locator('.pack-heading')).toContainText(installedManifest.packVersion);
  await context.unroute(manifestPattern);
  await context.route(manifestPattern, route => route.fulfill({ json: { ...installedManifest, packVersion: 'corrupted-test' } }));
  await context.route('**/packs/corrupted-test/*', route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1);
    const asset = installedManifest.files.find((file: { path: string; decodedBytes: number }) => file.path === path);
    return route.fulfill({ body: Buffer.alloc(asset.decodedBytes, 0), contentType: 'application/octet-stream' });
  });
  await page.getByRole('button', { name: 'Check for an update', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('integrity check failed');
  await expect(page.locator('.pack-heading')).toContainText(installedManifest.packVersion);
  await context.unroute(manifestPattern); await context.unroute('**/packs/corrupted-test/*');
  await context.route(manifestPattern, route => route.fulfill({ json: { ...installedManifest, packVersion: 'interrupted-test' } }));
  await context.route('**/packs/interrupted-test/*', async route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1);
    if (path !== installedManifest.files[0].path) return route.abort('failed');
    const validFirstFile = await request.get(`/packs/${encodeURIComponent(installedManifest.packVersion)}/${path}`);
    return route.fulfill({ response: validFirstFile });
  });
  await page.getByRole('button', { name: 'Check for an update', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText(/failed|load/i);
  await expect(page.locator('.pack-heading')).toContainText(installedManifest.packVersion);
  await context.unroute(manifestPattern); await context.unroute('**/packs/interrupted-test/*');

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('No connection detected', { exact: true })).toBeVisible();
  await expect(page.getByText('Offline assets installed', { exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'fictional-sale-evidence.png', mimeType: 'image/png', buffer: evidencePng });
  await expect(page.getByText('fictional-sale-evidence.png', { exact: true })).toBeVisible();
  await page.getByLabel('Your lot and offer').fill(`${english} Receipt id: ${sourceMarker}.`);
  await page.getByRole('button', { name: 'Review the details' }).click();
  const englishStarted = performance.now();
  await confirmAndCompare(page);
  timings.englishUiMs = performance.now() - englishStarted;
  const median = await page.locator('.reference-stat strong').innerText();
  const originalGroups = await page.locator('.evidence-details[open] ul li').allTextContents();
  await page.screenshot({ path: `${output}/desktop-offline-comparison.png`, fullPage: true });

  // The deployment artifact and training runtime must agree on the same q8 representation.
  // Predeclared tolerance: L2 <= 0.01 (cosine >= 0.9999), allowing CPU/WASM numeric differences.
  const workerAsset = readdirSync('dist/web/assets').find(name => /^encoder\.worker-.*\.js$/.test(name));
  expect(workerAsset).toBeTruthy();
  const parityText = 'Dry Arabica parchment coffee is hand-sorted and stored in clean sacks. The buyer collects at the farm.';
  const browserVector = await page.evaluate(async ({ workerUrl, description }) => new Promise<{ vector: number[]; inferenceMs: number }>((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Browser parity inference timed out.')); }, 90_000);
    worker.onmessage = ({ data }) => { clearTimeout(timeout); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data); };
    worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id: 9876, text: description });
  }), { workerUrl: `/assets/${workerAsset}`, description: parityText });
  const nodeVector = await encodeOnNode(parityText);
  await disposeEncoder();
  expect(browserVector.vector).toHaveLength(384); expect(nodeVector).toHaveLength(384);
  expect(browserVector.vector.every(Number.isFinite)).toBe(true); expect(nodeVector.every(Number.isFinite)).toBe(true);
  const l2 = Math.sqrt(nodeVector.reduce((sum, value, index) => sum + (value - browserVector.vector[index]!) ** 2, 0));
  const dot = nodeVector.reduce((sum, value, index) => sum + value * browserVector.vector[index]!, 0);
  const cosine = dot / Math.hypot(...nodeVector) / Math.hypot(...browserVector.vector);
  await test.info().attach('node-browser-q8-parity', { body: JSON.stringify({ encoderVersion: ENCODER_VERSION, dimensions: 384, l2, cosine, l2Tolerance: 0.01, minimumCosine: 0.9999, browserInferenceMs: browserVector.inferenceMs }), contentType: 'application/json' });
  expect(l2).toBeLessThanOrEqual(0.01); expect(cosine).toBeGreaterThanOrEqual(0.9999);

  // The offer is excluded from semantic features: a changed offer must keep the same reference.
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.getByLabel('Buyer’s offer').fill('5200');
  await confirmAndCompare(page);
  await expect(page.locator('.reference-stat strong')).toHaveText(median);
  await expect(page.locator('.evidence-details[open] ul li')).toHaveText(originalGroups);
  await expect(page.locator('.offer-value')).toContainText('5,200');

  // A corrected kg weight must replace the extracted source quantity, rather
  // than leave incompatible 50 kg and 60 kg monetary normalization inputs.
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.getByLabel('Weight (kg)', { exact: true }).fill('60');
  await confirmAndCompare(page);
  await expect(page.locator('.cash-summary strong')).toHaveText('312,000 TZS');
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.getByLabel('Weight (kg)', { exact: true }).fill('');
  await confirmAndCompare(page);
  await expect(page.locator('.cash-summary')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.getByLabel('Weight (kg)', { exact: true }).fill('50');
  await confirmAndCompare(page);
  await expect(page.locator('.cash-summary strong')).toHaveText('260,000 TZS');

  // Known contradictory processing state must not get a quantitative comparison.
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.locator('.optional-details summary').click();
  await page.getByLabel('Product form', { exact: true }).selectOption('cherry');
  await page.getByLabel('These are the details I want to compare.').check();
  await page.getByRole('button', { name: 'Confirm and compare' }).click();
  await expect(page.getByRole('heading', { name: 'More information is needed' })).toBeVisible();
  await expect(page.locator('.comparison-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.locator('.optional-details summary').click();
  await page.getByLabel('Product form', { exact: true }).selectOption('parchment');
  await confirmAndCompare(page);

  await page.getByRole('button', { name: 'Record the actual sale' }).click();
  await page.getByLabel('Upload this fictional sale for private review when connected.').check();
  await page.getByLabel('Allow an approved sale to contribute to an aggregate comparison pack.').check();
  await page.getByRole('button', { name: 'Save sale on this device' }).click();
  await expect(page.getByText('Queued for upload', { exact: true })).toBeVisible();
  await expect(page.locator('.record-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Compare an offer', exact: true }).first().click();
  await expect(page.getByLabel('Your lot and offer')).toHaveValue('');
  await expect(page.locator('.attachment-preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'My records', exact: true }).click();

  // Switching fictional people uses a distinct IndexedDB namespace.
  await page.locator('.device-controls select').selectOption('farmer-b');
  await expect(page.getByText('No sales recorded yet.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Compare an offer', exact: true }).first().click();
  await page.getByLabel('Language', { exact: true }).selectOption('fr');
  await page.getByLabel('Votre lot et l’offre').fill(french);
  await page.getByRole('button', { name: 'Vérifier les détails' }).click();
  const frenchCharges = page.getByLabel('Frais de vente (lot entier)', { exact: true });
  if (!await frenchCharges.inputValue()) await frenchCharges.fill('0');
  await page.getByLabel('Ce sont les détails que je souhaite comparer.').check();
  const frenchStarted = performance.now();
  await page.getByRole('button', { name: 'Confirmer et comparer' }).click();
  await expect(page.getByRole('heading', { name: 'Votre offre en contexte' })).toBeVisible({ timeout: 90_000 });
  timings.frenchUiMs = performance.now() - frenchStarted;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile-french-offline-comparison.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(unexpectedCalls).toEqual([]);

  // The named local language exercises input, monetary correction and a genuine model result/refusal.
  await page.getByRole('button', { name: 'Modifier les détails', exact: true }).click();
  await page.getByLabel('Language', { exact: true }).selectOption('sw');
  await page.getByRole('button', { name: 'Rudi', exact: true }).click();
  await page.getByLabel('Kahawa yako na ofa').fill(kiswahili);
  await page.getByRole('button', { name: 'Kagua maelezo' }).click();
  await page.getByLabel('Gharama za mauzo (mzigo wote)').fill('0');
  await page.getByLabel('Haya ndiyo maelezo ninayotaka kulinganisha.').check();
  const kiswahiliStarted = performance.now();
  await page.getByRole('button', { name: 'Thibitisha na linganisha' }).click();
  await expect(page.locator('.result-section h2')).toBeVisible({ timeout: 90_000 });
  timings.kiswahiliUiMs = performance.now() - kiswahiliStarted;
  const kiswahiliInitialResult = await page.locator('.result-section h2').innerText();
  await expect(page.getByText(/Maneno ya Kiswahili ni ya muda/)).toBeVisible();
  await page.screenshot({ path: `${output}/mobile-kiswahili-offline-result.png`, fullPage: true });
  await test.info().attach('kiswahili-result', { body: await page.locator('.result-section').innerText(), contentType: 'text/plain' });
  await page.getByRole('button', { name: 'Badilisha maelezo', exact: true }).click();
  await page.locator('.optional-details summary').click();
  await page.getByLabel('Hali ya kahawa', { exact: true }).selectOption('green');
  await page.getByLabel('Haya ndiyo maelezo ninayotaka kulinganisha.').check();
  await page.getByRole('button', { name: 'Thibitisha na linganisha' }).click();
  await expect(page.getByRole('heading', { name: 'Maelezo zaidi yanahitajika' })).toBeVisible();
  await expect(page.locator('.comparison-card')).toHaveCount(0);
  await page.screenshot({ path: `${output}/mobile-kiswahili-offline-refusal.png`, fullPage: true });

  await context.setOffline(false);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByLabel('Language', { exact: true }).selectOption('en');
  await page.locator('.device-controls select').selectOption('farmer-a');
  await page.getByRole('button', { name: 'My records', exact: true }).click();
  await page.getByRole('button', { name: 'Sync my records', exact: true }).first().click();
  await expect(page.getByText('Uploaded', { exact: true })).toBeVisible();
  await expect(page.getByText('Awaiting review', { exact: false })).toBeVisible();

  const initialPack = await (await request.get('/api/packs?cropId=coffee&regionId=ondera-demo')).json();
  await page.getByRole('button', { name: 'Publisher workspace' }).click();
  await page.getByLabel('Publisher credential').fill(secret);
  await page.getByRole('button', { name: 'Open private reports' }).click();
  const ownReport = page.locator('.review-report').filter({ hasText: sourceMarker });
  await expect(ownReport).toHaveCount(1);
  await expect(ownReport.getByText('1 private attachment reference', { exact: true })).toBeVisible();
  const evidenceResponse = page.waitForResponse(response => response.url().includes('/api/reviewer/evidence/') && response.status() === 200);
  await ownReport.getByRole('button', { name: 'Inspect private image 1', exact: true }).click();
  const evidenceUrl = new URL((await evidenceResponse).url());
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await page.getByRole('dialog').screenshot({ path: `${output}/publisher-private-evidence.png` });
  expect((await request.get(evidenceUrl.pathname)).status()).toBe(401);
  await page.getByRole('button', { name: 'Close image', exact: true }).click();
  await ownReport.getByLabel('Corroboration', { exact: true }).selectOption('receipt_attached');
  await ownReport.getByLabel('Review reason').fill('Fictional browser-test report confirmed against its stated sale terms.');
  await ownReport.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(ownReport.locator('.status-pill')).toHaveText('approved');
  await ownReport.screenshot({ path: `${output}/publisher-approved-report.png` });

  // Annotators see descriptions without report identities or sale amounts.
  // An unknown relation remains a clarification case rather than a negative.
  await page.locator('.comparison-label-panel summary').click();
  await expect(page.locator('.review-report')).toHaveCount(0);
  await page.getByLabel('Left source report', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Right source report', { exact: true }).selectOption({ index: 2 });
  await expect(page.locator('.annotation-description').first()).not.toContainText(/TZS|USD|KES|INR|contributorId/);
  await expect(page.locator('.annotation-description').last()).not.toContainText(/TZS|USD|KES|INR|contributorId/);
  await page.getByLabel('Judgment', { exact: true }).selectOption('unknown');
  await page.getByLabel('Evidence and rationale', { exact: true }).fill('Fictional test annotation: insufficient detail to determine comparability.');
  const labelResponse = page.waitForResponse(response => response.url().endsWith('/api/reviewer/comparisons') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Record comparison label', exact: true }).click();
  expect((await (await labelResponse).json()).trainingState).toBe('clarification_only');
  await expect(page.getByText(/Unknown comparison retained for clarification evaluation/)).toBeVisible();
  await page.locator('.comparison-label-panel').screenshot({ path: `${output}/publisher-comparison-annotation.png` });
  await page.locator('.comparison-label-panel summary').click();

  await page.getByRole('button', { name: 'Publish aggregate pack' }).click();
  await expect(page.getByText(/published\. Farmers must install/)).toBeVisible({ timeout: 90_000 });
  const updatedPack = await (await request.get('/api/packs?cropId=coffee&regionId=ondera-demo')).json();
  expect(updatedPack.packVersion).not.toBe(initialPack.packVersion);
  await page.getByRole('button', { name: 'Farmer workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Sync my records', exact: true }).first().click();
  await expect(page.getByText(/Included in pack/)).toBeVisible();
  await page.locator('.device-controls select').selectOption('farmer-b');
  await page.getByRole('button', { name: 'Check for an update', exact: true }).first().click();
  await expect(page.getByText('A new comparison pack is installed.', { exact: true })).toBeVisible();
  await expect(page.locator('.pack-heading')).toContainText(updatedPack.packVersion);
  await page.getByRole('button', { name: 'My records', exact: true }).click();
  await expect(page.getByText('No sales recorded yet.', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Offline assets installed', { exact: true })).toBeVisible();
  await page.locator('.device-controls select').selectOption('farmer-b');
  await page.getByLabel('Your lot and offer').fill('Dry Arabica parchment coffee was hand-sorted and kept in clean sacks in Ondera-Demo. The buyer collects at the farm and pays immediately. The offer is TZS 5100 per kg on 2026-10-04. There are no charges and no loan.');
  await page.getByRole('button', { name: 'Review the details' }).click();
  await expect(page.getByLabel('Weight (kg)', { exact: true })).toHaveValue('');
  await confirmAndCompare(page);
  await expect(page.locator('.pack-heading')).toContainText(updatedPack.packVersion);
  await expect(page.locator('.evidence-details[open]')).toContainText(updatedPack.packVersion);
  await page.screenshot({ path: `${output}/updated-pack-offline-comparison.png`, fullPage: true });
  expect(pageErrors).toEqual([]);
  const evidence = { browser: browser.version(), platform: process.platform, viewport: { width: 1280, height: 1000 }, externalRequestCount: unexpectedCalls.length, pageErrors, consoleErrors, timings,
    timingScope: 'Elapsed browser UI work including rendering; not isolated encoder latency.',
    parity: { encoderVersion: ENCODER_VERSION, dimensions: 384, l2, cosine, l2Tolerance: 0.01, minimumCosine: 0.9999, browserInferenceMs: browserVector.inferenceMs },
    languages: { english: 'comparison', french: 'comparison', kiswahiliInitialResult, kiswahiliKnownConflict: 'refusal', kiswahiliReviewerStatus: 'No independent fluent agricultural review' },
    checks: ['offline reload and unseen inference', 'offer price invariance', 'corrected and blank kg weight source normalization', 'known processing conflict refusal', 'persona record isolation', 'new journey clears prior receipt and interpretation', 'local attachment and protected inspection', 'anonymous comparison annotation with unknown clarification semantics', 'upload-review-publication-update', 'incompatible/corrupt/interrupted updates preserve prior pack', 'updated-pack offline inference with no weight for a per-kg quote'],
    initialPackVersion: installedManifest.packVersion, publishedPackVersion: updatedPack.packVersion,
  };
  writeFileSync(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
  await test.info().attach('browser-configuration', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('published payloads contain aggregates and model artifacts, not private source records', async ({ request }) => {
  const latest = await request.get('/api/packs?cropId=coffee&regionId=ondera-demo');
  expect(latest.ok()).toBe(true);
  const manifest = await latest.json();
  expect(manifest.schemaVersion).toBe(2);
  const response = await request.get(`/packs/${encodeURIComponent(manifest.packVersion)}/pack.json`);
  expect(response.ok()).toBe(true);
  const pack = await response.json();
  expect(pack.groups.length).toBeGreaterThan(0);
  const privateKeys = new Set(['transactions', 'records', 'contributorId', 'lotId', 'clientReportId', 'rawText', 'originalText', 'attachmentRefs', 'evidenceRefs', 'statusToken']);
  function assertAggregateOnly(value: unknown) {
    if (Array.isArray(value)) { value.forEach(assertAggregateOnly); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      expect(privateKeys.has(key), `private source field ${key}`).toBe(false);
      assertAggregateOnly(child);
    }
  }
  assertAggregateOnly(manifest); assertAggregateOnly(pack);
});
