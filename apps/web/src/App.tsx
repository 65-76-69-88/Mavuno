import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, CloudUpload, Download, FileImage, FileText, Info, Leaf, LoaderCircle, RefreshCw, ShieldCheck, Wifi, WifiOff, X } from './icons';
import { client } from './services/client';
import { confirmFacts } from '@pricemesh/domain';
import { copy, examples, formatDate, formatNumber, type Copy } from './i18n';
import type { AppSnapshot, Comparison, Language, ParsedOffer, Persona, PersonalRecord, SaleFacts } from './ui-contract';
import ReviewerWorkspace from './components/ReviewerWorkspace';
import Field from './components/Field';

type Step = 'describe' | 'confirm' | 'compare' | 'record';
type Journey = {
  step: Step;
  description: string;
  parsed?: ParsedOffer;
  inputLanguage?: Language;
  result?: Comparison;
  confirmed: boolean;
  attachment?: File;
  uploadConsent: boolean;
  aggregateConsent: boolean;
};
const initialJourney = (): Journey => ({ step: 'describe', description: '', confirmed: false, uploadConsent: false, aggregateConsent: false });
const emptySnapshot: AppSnapshot = { installation: { ready: false, phase: '', progress: 0 }, records: [] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A field change is user-confirmed and retains the original evidence references. */
function changeFact(facts: SaleFacts, key: keyof SaleFacts, value: string): SaleFacts {
  const confirmedValue = value.trim() || null;
  const changed = { ...facts, [key]: { ...facts[key], value: confirmedValue, status: 'confirmed', sourceRefs: [...new Set([...facts[key].sourceRefs, 'user-confirmation'])] } } as SaleFacts;
  // The weight editor explicitly uses kg. Keep the normalization source aligned
  // with a corrected weight while retaining the original narrative references.
  if (key === 'quantityKg') {
    changed.sourceQuantity = { ...facts.sourceQuantity, value: confirmedValue, status: 'confirmed', sourceRefs: [...new Set([...facts.sourceQuantity.sourceRefs, 'user-confirmation'])] };
    changed.sourceUnit = { ...facts.sourceUnit, value: confirmedValue ? 'kg' : null, status: 'confirmed', sourceRefs: [...new Set([...facts.sourceUnit.sourceRefs, 'user-confirmation'])] };
  }
  return changed;
}

function FactFields({ facts, onChange, t, record = false }: {
  facts: SaleFacts; onChange: (key: keyof SaleFacts, value: string) => void; t: Copy; record?: boolean;
}) {
  const value = (key: keyof SaleFacts) => facts[key].value ?? '';
  const amountKey = value('priceBasis') === 'per_kg' ? 'quotedUnitPrice' : 'cropConsideration';
  const select = (key: keyof SaleFacts, options: [string, string][]) => <select value={value(key)} onChange={event => onChange(key, event.target.value)}>
    <option value="">{t.unknown}</option>{options.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
  </select>;
  const number = (key: keyof SaleFacts, required = false) => <input type="number" inputMode="decimal" min="0" step="any" value={value(key)} required={required} onChange={event => onChange(key, event.target.value)} placeholder={t.unknown} />;
  return <>
    <div className="form-grid">
      <Field label={t.priceBasis}>{select('priceBasis', [['per_kg', t.perKg], ['lot', t.lot]])}</Field>
      <Field label={t.currency}>{select('currency', [['TZS', 'TZS'], ['USD', 'USD'], ['KES', 'KES'], ['INR', 'INR']])}</Field>
      <Field label={record ? t.finalAmount : t.amount}>{number(amountKey, !record)}</Field>
      <Field label={t.quantity}>{number('quantityKg', !record && value('priceBasis') === 'lot')}</Field>
      <Field label={t.costs}>{number('saleCosts', !record)}</Field>
      <Field label={t.loan}>{number('loanSettlement')}</Field>
      <Field label={t.date}><input type="date" value={value('saleDate')} required={!record} onChange={event => onChange('saleDate', event.target.value)} /></Field>
      <Field label={t.market}>{select('marketAreaId', [['ondera-demo', t.local], ['other-market', t.otherMarket]])}</Field>
    </div>
    <details className="optional-details">
      <summary>{t.edit} <ChevronDown size={16} aria-hidden="true" /></summary>
      <p className="small muted">{t.scope}</p>
      <div className="form-grid">
        <Field label={t.crop}>{select('species', [['arabica', t.arabica], ['robusta', t.robusta]])}</Field>
        <Field label={t.form}>{select('productForm', [['parchment', t.parchment], ['cherry', t.cherry], ['green', t.green]])}</Field>
        <Field label={t.sorting}>{select('sorting', [['sorted', t.sorted], ['mixed', t.mixed]])}</Field>
        <Field label={t.moisture}>{number('moisturePct')}</Field>
        <Field label={t.channel}>{select('saleChannel', [['farmgate', t.farmgate], ['other-channel', t.otherChannel]])}</Field>
        <Field label={t.delivery}>{select('deliveryTerms', [['buyer_collects', t.collects], ['seller_delivers', t.delivers]])}</Field>
        <Field label={t.payment}>{select('paymentTerms', [['immediate', t.immediate], ['deferred', t.deferred]])}</Field>
      </div>
    </details>
  </>;
}

function PriceComparison({ result, language, t }: { result: Comparison; language: Language; t: Copy }) {
  if (result.median === undefined || result.offer === undefined || result.q25 === undefined || result.q75 === undefined) return null;
  const amount = (value: number) => `${formatNumber(value, language, 2)} ${result.currency ?? 'TZS'}/kg`;
  const low = Math.min(result.offer, result.q25) * 0.9;
  const high = Math.max(result.offer, result.q75) * 1.1;
  const position = (value: number) => `${Math.max(0, Math.min(100, (value - low) / (high - low || 1) * 100))}%`;
  const delta = result.deltaPct ?? ((result.offer - result.median) / result.median * 100);
  return <div className="comparison-card">
    <span className="eyebrow">{t.yourOffer}</span>
    <div className="offer-value">{formatNumber(result.offer, language, 2)}<span>{result.currency ?? 'TZS'}/kg</span></div>
    <p className="offer-delta"><strong>{formatNumber(Math.abs(delta), language, 1)}%</strong> {Math.abs(delta) < 0.5 ? t.same : delta < 0 ? t.below : t.above}</p>
    <div className="reference-stat"><span>{t.median}</span><strong>{amount(result.median)}</strong></div>
    <div className="range-chart" role="img" aria-label={`${t.yourOffer}: ${amount(result.offer)}. ${t.middle}: ${amount(result.q25)} – ${amount(result.q75)}. ${t.median}: ${amount(result.median)}.`}>
      <div className="range-track"><div className="range-middle" style={{ left: position(result.q25), width: `${(result.q75 - result.q25) / (high - low || 1) * 100}%` }} /><div className="range-median" style={{ left: position(result.median) }} /><div className="range-offer" style={{ left: position(result.offer) }} /></div>
      <div className="range-labels"><span>{formatNumber(result.q25, language)}<br /><small>Q25</small></span><span>{formatNumber(result.q75, language)}<br /><small>Q75</small></span></div>
      <p>{t.middle}</p>
    </div>
    <p className="small muted">{t.rounded}</p>
  </div>;
}

function ResultView({ result, language, t, ownDescription, sourceCurrency, onEdit, onRecord, onNew }: {
  result: Comparison; language: Language; t: Copy; ownDescription: string; sourceCurrency?: string; onEdit: () => void; onRecord: () => void; onNew: () => void;
}) {
  const compared = result.outcome === 'compared';
  return <section className="workflow-section result-section">
    <div className={`result-icon ${compared ? '' : 'warning'}`}>{compared ? <Leaf size={23} /> : <Info size={23} />}</div>
    <h2 tabIndex={-1}>{compared ? t.offerTitle : t.noComparison}</h2>
    <p className="section-intro">{result.explanation}</p>
    {result.cohortLabel && <p className="cohort-label">{result.cohortLabel}</p>}
    {compared && <PriceComparison result={result} language={language} t={t} />}
    {compared && result.cashReceived !== undefined && sourceCurrency && <div className="cash-summary"><span>{t.cash}</span><strong>{formatNumber(result.cashReceived, language, 2)} {sourceCurrency}</strong></div>}
    <div className="next-step"><span className="eyebrow">{t.nextQuestion}</span><p>{result.nextStep}</p></div>
    {compared && <p className="small muted decision-note">{t.notFairPrice}</p>}
    {(result.coverage.length > 0 || result.observationWindow) && <details className="evidence-details" open>
      <summary><ShieldCheck size={17} aria-hidden="true" /> {t.evidence}<ChevronDown size={16} /></summary>
      <div className="own-evidence"><span className="eyebrow">{t.yourEvidence}</span><p>{ownDescription}</p><p className="muted">{t.reportedEvidence}</p></div>
      {result.observationWindow && <p className="small">{result.observationWindow}</p>}
      <ul>{result.coverage.map(item => <li key={item}>{item}</li>)}</ul>
      {result.packVersion && <p className="small muted">{t.pack} {result.packVersion}</p>}
    </details>}
    {result.limitations.length > 0 && <details className="evidence-details"><summary><Info size={17} />{t.limitations}<ChevronDown size={16} /></summary><ul>{result.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>}
    {result.exclusions.length > 0 && <details className="evidence-details"><summary>{t.exclusions}<ChevronDown size={16} /></summary><ul>{result.exclusions.map(item => <li key={item}>{item}</li>)}</ul></details>}
    <div className="button-stack">
      <button className="button primary" onClick={compared ? onRecord : onEdit}>{compared ? t.recordSale : t.edit}<ArrowRight size={17} /></button>
      {!compared && <button className="button outline" onClick={onRecord}>{t.recordSale}</button>}
      <button className="button subtle" onClick={compared ? onEdit : onNew}>{compared ? t.edit : t.newComparison}</button>
    </div>
  </section>;
}

function RecordList({ records, language, t, onCompare }: { records: PersonalRecord[]; language: Language; t: Copy; onCompare: () => void }) {
  const status = (record: PersonalRecord) => record.outbox === 'local' ? t.localOnly : t[record.outbox];
  return <section className="workflow-section">
    <span className="eyebrow">{t.farmer}</span><h2>{t.recordsTitle}</h2><p className="section-intro">{t.recordsText}</p>
    <p className="small muted">{t.recordStages}</p>
    {!records.length ? <div className="empty-records"><FileText size={32} strokeWidth={1.5} /><h3>{t.emptyRecords}</h3><p>{t.emptyRecordsText}</p><button className="button primary" onClick={onCompare}>{t.compareNav}<ArrowRight size={16} /></button></div>
      : <div className="record-list">{records.map(record => <article className="record-card" key={record.id}>
        <div className="record-card-header"><strong>{formatDate(record.facts.saleDate.value ?? record.createdAt, language)}</strong><span className={`status-pill ${record.outbox === 'uploaded' ? 'success' : ''}`}>{status(record)}</span></div>
        <p>{record.description}</p>
        <div className="record-amount">{record.facts.priceBasis.value === 'per_kg' ? record.facts.quotedUnitPrice.value : record.facts.cropConsideration.value} {record.facts.currency.value}{record.facts.priceBasis.value === 'per_kg' ? '/kg' : ''}<span>{record.facts.quantityKg.value && `${record.facts.quantityKg.value} kg`}</span></div>
        {record.outbox === 'uploaded' && <p className="small review-state"><ShieldCheck size={14} />{t[record.reviewState]}{record.includedVersion && <> · {t.published} {record.includedVersion}</>}</p>}
        {record.error && <p className="record-error">{record.error}</p>}
      </article>)}</div>}
  </section>;
}

export default function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [persona, setPersona] = useState<Persona>('farmer-a');
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [journeys, setJourneys] = useState<Record<Persona, Journey>>({ 'farmer-a': initialJourney(), 'farmer-b': initialJourney() });
  const [nav, setNav] = useState<'compare' | 'records'>('compare');
  const [reviewer, setReviewer] = useState(new URLSearchParams(window.location.search).get('view') === 'reviewer');
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const content = useRef<HTMLDivElement>(null);
  const t = copy[language];
  const journey = journeys[persona];
  const setJourney = (changes: Partial<Journey>) => setJourneys(previous => ({ ...previous, [persona]: { ...previous[persona], ...changes } }));
  const resetJourney = () => setJourneys(previous => ({ ...previous, [persona]: initialJourney() }));
  const refresh = useCallback(async () => setSnapshot(await client.snapshot(persona)), [persona]);

  useEffect(() => {
    let active = true;
    setSnapshot(previous => ({ ...previous, records: [] }));
    client.snapshot(persona).then(value => { if (active) setSnapshot(value); }).catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [persona]);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected); window.addEventListener('offline', disconnected);
    return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected); };
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => { content.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true }); }, [journey.step, nav]);

  async function perform(action: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(action); setError(undefined); setNotice(undefined);
    try { await task(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(undefined); }
  }

  const install = () => perform('install', async () => {
    await client.install(installation => setSnapshot(previous => ({ ...previous, installation })));
    await refresh();
  });
  const sync = () => perform('sync', async () => { await client.sync(persona); await refresh(); setNotice(t.synced); });
  const update = () => perform('update', async () => { const result = await client.updatePack(); await refresh(); setNotice(result.updated ? t.updated : t.noUpdate); });
  const interpret = (event: FormEvent) => {
    event.preventDefault();
    void perform('interpret', async () => {
      const parsed = await client.interpret(journey.description, language);
      setJourney({ parsed, inputLanguage: language, step: 'confirm', confirmed: false, result: undefined });
    });
  };
  const compare = (event: FormEvent) => {
    event.preventDefault();
    if (!journey.parsed) return;
    if (!journey.confirmed) { setError(t.requiredConfirm); return; }
    if (!snapshot.installation.ready) { setError(t.installNeeded); return; }
    void perform('compare', async () => {
      const facts = confirmFacts(journey.parsed!.facts, ['cropId', 'marketAreaId', 'saleDate', 'saleChannel', 'priceBasis', 'currency', 'quotedUnitPrice', 'cropConsideration', 'saleCosts', 'loanSettlement', 'quantityKg', 'sourceQuantity', 'sourceUnit']);
      const result = await client.compare(facts, journey.parsed!.lotDescription, language);
      setJourney({ parsed: { ...journey.parsed!, facts }, result, step: 'compare' });
    });
  };
  const change = (key: keyof SaleFacts, value: string) => {
    if (!journey.parsed) return;
    const facts = changeFact(journey.parsed.facts, key, value);
    setJourney({ parsed: { ...journey.parsed, facts }, confirmed: false });
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!journey.parsed) return;
    void perform('save', async () => {
      const facts = confirmFacts(journey.parsed!.facts, ['cropId', 'marketAreaId', 'saleDate', 'saleChannel', 'priceBasis', 'currency', 'quotedUnitPrice', 'cropConsideration', 'saleCosts', 'loanSettlement', 'quantityKg', 'sourceQuantity', 'sourceUnit']);
      await client.saveSale(persona, { facts, description: journey.description, lotDescription: journey.parsed!.lotDescription, language: journey.inputLanguage ?? language, consent: { upload: journey.uploadConsent, aggregateUse: journey.uploadConsent && journey.aggregateConsent }, attachment: journey.attachment });
      await refresh(); resetJourney(); setNav('records'); setNotice(t.saved);
    });
  };
  const newComparison = () => { resetJourney(); setNav('compare'); setError(undefined); setNotice(undefined); };
  const chooseFile = (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError(t.fileInvalid); return; }
    setError(undefined); setJourney({ attachment: file });
  };
  const steps: Step[] = ['describe', 'confirm', 'compare', 'record'];
  const stepLabels = [t.stepDescribe, t.stepConfirm, t.stepCompare, t.stepRecord];

  if (reviewer) return <ReviewerWorkspace onBack={() => setReviewer(false)} />;

  return <div className="app-shell">
    <header className="site-header"><div className="brand"><Leaf size={23} strokeWidth={1.8} /><span>{t.appName}</span><small>{t.prototype}</small></div><button className="publisher-link" onClick={() => setReviewer(true)}><ShieldCheck size={15} />{t.publisher}<ArrowRight size={14} /></button></header>
    <main className="main-layout">
      <aside className="context-panel">
        <span className="scope-tag">{t.scope}</span>
        <h1>{t.headline.split('\n').map(line => <span key={line}>{line}</span>)}</h1>
        <p className="context-introduction">{t.introduction}</p>
        <div className="journey-explainer">
          {[t.stepDescribe, t.stepConfirm, t.stepCompare, t.stepRecord].map((label, index) => <div key={label}><span>{String(index + 1).padStart(2, '0')}</span><strong>{label}</strong>{index !== 3 && <span className="explainer-line" />}</div>)}
        </div>
        <div className="device-controls">
          <label><span>{t.farmer}</span><select value={persona} disabled={!!busy} onChange={event => { setPersona(event.target.value as Persona); setError(undefined); setNotice(undefined); }}><option value="farmer-a">{t.personaA}</option><option value="farmer-b">{t.personaB}</option></select></label>
          <p className="small muted">{t.personaNote}</p>
        </div>
        <div className="pack-card">
          <div className="pack-heading"><Download size={18} /><strong>{snapshot.pack ? `${t.pack} ${snapshot.pack.version}` : t.packMissing}</strong></div>
          {snapshot.pack && <dl><div><dt>{t.packAsOf}</dt><dd>{formatDate(snapshot.pack.asOf, language)}</dd></div><div><dt>{t.expires}</dt><dd>{formatDate(snapshot.pack.validUntil, language)}</dd></div>{snapshot.pack.lastUpdated && <div><dt>{t.lastInstalled}</dt><dd>{formatDate(snapshot.pack.lastUpdated, language)}</dd></div>}</dl>}
          <button className="button outline compact" onClick={() => void update()} disabled={!!busy || !online}><RefreshCw className={busy === 'update' ? 'spin' : ''} size={15} />{t.update}</button>
          <button className="button outline compact" onClick={() => void sync()} disabled={!!busy || !online}><CloudUpload className={busy === 'sync' ? 'pulse' : ''} size={15} />{t.sync}</button>
        </div>
        <p className="small muted context-footer">{t.footer}</p>
      </aside>

      <div className="phone-column">
        <div className="phone-frame">
          <div className="device-topbar"><span>{persona === 'farmer-a' ? 'Noor' : 'Amani'}</span><div className={`connection-state ${online ? '' : 'disconnected'}`}>{online ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{online ? t.connection : t.offline}</span></div></div>
          <div className="phone-header"><div><span className="eyebrow">{t.scope}</span><strong>{t.appName}</strong></div><label className="language-picker"><span className="sr-only">Language</span><select aria-label="Language" value={language} disabled={!!busy} onChange={event => { setLanguage(event.target.value as Language); setNotice(undefined); if (journey.step === 'compare') setJourney({ step: 'confirm', result: undefined }); }}><option value="en">English</option><option value="fr">Français</option><option value="sw">Kiswahili</option></select></label></div>
          <div className="synthetic-banner"><Info size={13} /><span>{t.synthetic}</span></div>
          <nav className="phone-nav" aria-label="Farmer views"><button className={nav === 'compare' ? 'active' : ''} onClick={() => setNav('compare')}>{t.compareNav}</button><button className={nav === 'records' ? 'active' : ''} onClick={() => setNav('records')}>{t.recordsNav}{snapshot.records.length > 0 && <span aria-hidden="true">{snapshot.records.length}</span>}</button></nav>
          <div className="phone-content" ref={content}>
            {error && <div className="message error-message" role="alert"><Info size={17} /><p>{error}</p><button aria-label="Dismiss error" onClick={() => setError(undefined)}><X size={16} /></button></div>}
            {notice && <div className="message success-message" role="status"><CheckCircle2 size={17} /><p>{notice}</p><button aria-label="Dismiss message" onClick={() => setNotice(undefined)}><X size={16} /></button></div>}
            {language === 'sw' && <p className="language-review"><Info size={13} />{t.languageReview}</p>}
            {!snapshot.installation.ready && <section className="installation-card">
              <div className="installation-icon"><Download size={20} /></div><div><h3>{t.installTitle}</h3><p>{t.installText}</p></div>
              {busy === 'install' && <div className="install-progress" role="status"><progress value={snapshot.installation.progress} max={100} /><span>{snapshot.installation.phase || t.installing} {snapshot.installation.totalBytes ? `· ${formatNumber((snapshot.installation.downloadedBytes ?? 0) / 1024 / 1024, language, 1)} / ${formatNumber(snapshot.installation.totalBytes / 1024 / 1024, language, 1)} MB` : ''}</span></div>}
              {snapshot.installation.error && <p className="record-error">{snapshot.installation.error}</p>}
              <button className="button primary compact" disabled={!!busy || !online} onClick={() => void install()}>{busy === 'install' ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{snapshot.installation.error ? t.retryInstall : t.install}</button>
            </section>}
            {snapshot.installation.ready && <p className="installed-line"><CheckCircle2 size={14} />{t.ready}</p>}

            {nav === 'records' ? <RecordList records={snapshot.records} language={language} t={t} onCompare={newComparison} /> : <>
              <ol className="stepper" aria-label="Comparison steps">{steps.map((step, index) => <li className={step === journey.step ? 'current' : steps.indexOf(journey.step) > index ? 'complete' : ''} key={step}><span>{steps.indexOf(journey.step) > index ? <Check size={12} /> : index + 1}</span><small>{stepLabels[index]}</small></li>)}</ol>
              {journey.step === 'describe' && <form className="workflow-section" onSubmit={interpret}>
                <h2 tabIndex={-1}>{t.describeTitle}</h2><p className="section-intro">{t.describeText}</p>
                <Field label={t.description}><textarea required rows={6} maxLength={4000} value={journey.description} onChange={event => setJourney({ description: event.target.value })} placeholder={t.placeholder} /></Field>
                <button className="sample-button" type="button" onClick={() => setJourney({ description: examples[language] })}>{t.sample}<ArrowRight size={13} /></button>
                <label className="attachment-button"><FileImage size={17} /><span>{t.attachment}</span><input type="file" accept="image/png,image/jpeg" onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
                {journey.attachment && <div className="attachment-preview"><FileImage size={15} /><span>{journey.attachment.name}</span><button type="button" aria-label={t.removeAttachment} onClick={() => setJourney({ attachment: undefined })}><X size={15} /></button></div>}
                <p className="small muted">{t.attachmentNote}</p>
                <button className="button primary" type="submit" disabled={!!busy || !journey.description.trim()}>{busy === 'interpret' ? <LoaderCircle size={17} className="spin" /> : null}{busy === 'interpret' ? t.interpreting : t.interpret}{busy !== 'interpret' && <ArrowRight size={17} />}</button>
                <p className="capability-note"><Info size={14} />{t.textBoundary}</p>
              </form>}
              {journey.step === 'confirm' && journey.parsed && <form className="workflow-section" onSubmit={compare}>
                <button type="button" className="back-button" onClick={() => setJourney({ step: 'describe' })}><ArrowLeft size={14} />{t.back}</button>
                <h2 tabIndex={-1}>{t.confirmTitle}</h2><p className="section-intro">{t.confirmText}</p>
                {journey.parsed.issues.length > 0 && <div className="clarification-box"><Info size={16} /><ul>{journey.parsed.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
                <Field label={t.description}><textarea rows={3} value={journey.parsed.lotDescription} onChange={event => setJourney({ parsed: { ...journey.parsed!, lotDescription: event.target.value }, confirmed: false })} /></Field>
                <FactFields facts={journey.parsed.facts} onChange={change} t={t} />
                <label className="checkbox-label"><input type="checkbox" checked={journey.confirmed} onChange={event => setJourney({ confirmed: event.target.checked })} /><span>{t.confirmed}</span></label>
                <button className="button primary" type="submit" disabled={!!busy || !snapshot.installation.ready}>{busy === 'compare' ? <LoaderCircle size={17} className="spin" /> : null}{busy === 'compare' ? t.comparing : t.confirmButton}{busy !== 'compare' && <ArrowRight size={17} />}</button>
              </form>}
              {journey.step === 'compare' && journey.result && <ResultView result={journey.result} language={language} t={t} ownDescription={journey.parsed?.lotDescription ?? journey.description} sourceCurrency={journey.parsed?.facts.currency.value ?? undefined} onEdit={() => setJourney({ step: 'confirm', confirmed: false })} onRecord={() => setJourney({ step: 'record' })} onNew={newComparison} />}
              {journey.step === 'record' && journey.parsed && <form className="workflow-section" onSubmit={save}>
                <button type="button" className="back-button" onClick={() => setJourney({ step: 'compare' })}><ArrowLeft size={14} />{t.back}</button>
                <h2 tabIndex={-1}>{t.recordTitle}</h2><p className="section-intro">{t.recordText}</p>
                <FactFields facts={journey.parsed.facts} onChange={change} t={t} record />
                <label className="checkbox-label"><input type="checkbox" checked={journey.uploadConsent} onChange={event => setJourney({ uploadConsent: event.target.checked })} /><span>{t.consentUpload}</span></label>
                {journey.uploadConsent && <label className="checkbox-label"><input type="checkbox" checked={journey.aggregateConsent} onChange={event => setJourney({ aggregateConsent: event.target.checked })} /><span>{t.consentAggregate}</span></label>}
                <p className="small muted">{t.consentNote}</p>
                <button className="button primary" type="submit" disabled={!!busy}>{busy === 'save' ? <LoaderCircle size={17} className="spin" /> : <CheckCircle2 size={17} />}{t.save}</button>
              </form>}
            </>}
          </div>
          <div className="phone-footer"><Leaf size={14} /><span>{t.notFairPrice}</span></div>
        </div>
        <div className="mobile-device-controls"><label><span>{t.farmer}</span><select aria-label={t.farmer} value={persona} disabled={!!busy} onChange={event => { setPersona(event.target.value as Persona); setError(undefined); setNotice(undefined); }}><option value="farmer-a">{t.personaA}</option><option value="farmer-b">{t.personaB}</option></select></label><div><button className="button outline compact" disabled={!!busy || !online} onClick={() => void sync()}><CloudUpload size={15} />{t.sync}</button><button className="button outline compact" disabled={!!busy || !online} onClick={() => void update()}><RefreshCw size={15} />{t.update}</button></div><p className="small muted">{snapshot.pack && `${t.pack} ${snapshot.pack.version} · ${t.packAsOf} ${formatDate(snapshot.pack.asOf, language)} · ${t.expires} ${formatDate(snapshot.pack.validUntil, language)}`}</p><p className="small muted">{t.personaNote}</p></div>
      </div>
    </main>
  </div>;
}
