import { useEffect, useRef, useState, type FormEvent } from 'react';
import Field from './Field';
import { ArrowLeft, CheckCircle2, ChevronDown, FileText, Info, LoaderCircle, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Upload } from '../icons';

type ObjectValue = Record<string, unknown>;
type ReviewOutcome = 'approved' | 'rejected' | 'withdrawn';
interface ReviewReport {
  id: string;
  rawText: string;
  description: string;
  reviewState: string;
  createdAt: string;
  contributorId: string;
  money: ObjectValue;
  context: ObjectValue;
  observations: ObjectValue[];
  facts: ObjectValue;
  includedVersion?: string;
  evidenceCount: number;
  evidenceIds: string[];
}

const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, fallback = '—'): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const factValue = (value: unknown) => text(object(value).value);

function decodeReport(value: unknown): ReviewReport {
  const row = object(value);
  const payload = { ...row, ...object(row.payload), ...object(row.record) };
  const evidenceIds = array(payload.attachmentRefs ?? payload.evidenceRefs ?? row.evidence).map(item => typeof item === 'string' ? item : text(object(item).id, '')).filter(Boolean);
  return {
    id: text(row.id ?? row.reportId ?? payload.id, ''),
    rawText: text(payload.rawText ?? payload.originalText, ''),
    description: text(payload.descriptionText ?? payload.originalText, ''),
    reviewState: text(row.reviewState ?? payload.reviewState, 'unreviewed'),
    createdAt: text(row.createdAt ?? payload.createdAt, ''),
    contributorId: text(payload.contributorId),
    money: object(payload.money), context: object(payload.context),
    observations: array(payload.observations).map(object),
    facts: object(payload.facts),
    includedVersion: object(row.publication).included === true ? text(object(row.publication).packVersion) : typeof row.includedVersion === 'string' ? row.includedVersion : typeof row.publishedInVersion === 'string' ? row.publishedInVersion : undefined,
    evidenceCount: evidenceIds.length, evidenceIds,
  };
}

export default function ReviewerWorkspace({ onBack }: { onBack: () => void }) {
  const [credential, setCredential] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [reports, setReports] = useState<ReviewReport[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [verifications, setVerifications] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [leftReportId, setLeftReportId] = useState('');
  const [rightReportId, setRightReportId] = useState('');
  const [comparisonLabel, setComparisonLabel] = useState('unknown');
  const [comparisonReason, setComparisonReason] = useState('');
  const [labelMode, setLabelMode] = useState(false);
  const [corrections, setCorrections] = useState<Record<string, { descriptionText?: string; amount?: string; cropCharges?: string }>>({});
  const [imagePreview, setImagePreview] = useState<{ url: string; id: string }>();
  const imageDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (imagePreview) imageDialog.current?.showModal();
    return () => { if (imagePreview) URL.revokeObjectURL(imagePreview.url); };
  }, [imagePreview]);

  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
    let result: unknown;
    try { result = await response.json(); } catch { throw new Error(`Publisher request failed (${response.status}). Check the server connection.`); }
    if (!response.ok) throw new Error(text(object(result).error ?? object(result).message, `Request failed (${response.status})`));
    return result;
  }
  async function load() {
    const response = await request('/api/reviewer/reports');
    const rows = Array.isArray(response) ? response : array(object(response).reports);
    setReports(rows.map(decodeReport).filter(report => report.id));
    setUnlocked(true);
  }
  async function perform(action: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(action); setError(undefined); setNotice(undefined);
    try { await task(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(undefined); }
  }
  function unlock(event: FormEvent) { event.preventDefault(); void perform('unlock', load); }
  const review = (report: ReviewReport, outcome: ReviewOutcome) => perform(report.id, async () => {
    const reason = reasons[report.id]?.trim();
    if (!reason) throw new Error('Enter an evidence-based review reason before recording a decision.');
    const correction = corrections[report.id];
    const money = Object.keys(report.money).length ? report.money : {
      amount: factValue(report.facts.priceBasis) === 'per_kg' ? factValue(report.facts.quotedUnitPrice) : factValue(report.facts.cropConsideration),
      currency: factValue(report.facts.currency), basis: factValue(report.facts.priceBasis),
      quantityKg: factValue(report.facts.quantityKg), cropCharges: factValue(report.facts.saleCosts),
      loanSettlement: factValue(report.facts.loanSettlement), sourceRefs: ['review-correction'], status: 'confirmed',
    };
    await request(`/api/reviewer/reports/${encodeURIComponent(report.id)}/review`, {
      outcome, reason, verification: verifications[report.id] ?? 'seller_reported',
      ...(correction ? { corrections: {
        ...(correction.descriptionText === undefined ? {} : { descriptionText: correction.descriptionText }),
        ...(correction.amount === undefined && correction.cropCharges === undefined ? {} : { money: {
          ...money, status: 'confirmed',
          ...(correction.amount === undefined ? {} : { amount: correction.amount }),
          ...(correction.cropCharges === undefined ? {} : { cropCharges: correction.cropCharges }),
        } }),
      } } : {}),
    });
    await load(); setNotice(`Review recorded: ${outcome}. Publication remains a separate step.`);
  });
  const publish = () => perform('publish', async () => {
    const result = object(await request('/api/reviewer/publish', {}));
    const manifest = Object.keys(object(result.manifest)).length ? object(result.manifest) : result;
    await load(); setNotice(`Aggregate pack ${text(manifest.packVersion ?? result.packVersion, '')} published. Farmers must install the update to use it.`);
  });
  const logout = () => { setCredential(''); setUnlocked(false); setReports([]); setReasons({}); setVerifications({}); setCorrections({}); setImagePreview(undefined); setNotice(undefined); setError(undefined); };
  const inspectAttachment = (id: string) => perform(`evidence-${id}`, async () => {
    const response = await fetch(`/api/reviewer/evidence/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${credential}` }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Private evidence could not be opened (${response.status}).`);
    const image = await response.blob();
    if (!['image/png', 'image/jpeg'].includes(image.type)) throw new Error('Unsupported evidence image type.');
    setImagePreview({ url: URL.createObjectURL(image), id });
  });
  const labelComparison = (event: FormEvent) => {
    event.preventDefault();
    void perform('label', async () => {
      if (leftReportId === rightReportId) throw new Error('Choose two different source reports.');
      const result = object(await request('/api/reviewer/comparisons', { leftReportId, rightReportId, label: comparisonLabel, rationale: comparisonReason.trim() }));
      setComparisonReason(''); setNotice(result.trainingState === 'clarification_only' ? 'Unknown comparison retained for clarification evaluation. It does not become a training negative.' : 'Comparison label recorded in the training queue. This does not retrain or change the deployed model.');
    });
  };
  const changeCorrection = (id: string, key: 'descriptionText' | 'amount' | 'cropCharges', value: string) => setCorrections(previous => ({ ...previous, [id]: { ...previous[id], [key]: value } }));

  return <div className="reviewer-shell">
    <header className="reviewer-header"><button className="back-button" onClick={onBack}><ArrowLeft size={16} />Farmer workspace</button><span className="scope-tag"><ShieldCheck size={14} />Protected publisher view</span>{unlocked && <button className="back-button" onClick={logout}><LogOut size={15} />Lock workspace</button>}</header>
    <main className="reviewer-main">
      <span className="eyebrow">Private evidence → reviewed aggregates</span><h1>Keep the evidence accountable.</h1>
      <p className="reviewer-intro">Review fictional source reports, record the reason for each decision, then publish a new comparison pack. Upload, approval and publication remain distinct.</p>
      <div className="synthetic-banner reviewer-banner"><Info size={15} />Synthetic reports only. This demonstration is resettable and does not provide production identities or data custody.</div>
      {error && <div className="message error-message" role="alert"><Info size={18} /><p>{error}</p></div>}
      {notice && <div className="message success-message" role="status"><CheckCircle2 size={18} /><p>{notice}</p></div>}
      {!unlocked ? <form className="publisher-login" onSubmit={unlock}>
        <LockKeyhole size={30} strokeWidth={1.5} /><h2>Open the publisher workspace</h2><p>The service checks your publisher credential. It is held only in this page’s memory.</p>
        <Field label="Publisher credential"><input autoComplete="off" type="password" required value={credential} onChange={event => setCredential(event.target.value)} placeholder="Enter the configured reviewer secret" /></Field>
        <button className="button primary" disabled={!!busy} type="submit">{busy && <LoaderCircle size={16} className="spin" />}Open private reports<ArrowLeft size={16} className="reverse" /></button>
      </form> : <>
        <div className="publisher-toolbar"><div><strong>{reports.length} source reports</strong><span>Protected source view · fictional evidence</span></div><button className="button outline compact" disabled={!!busy} onClick={() => void perform('refresh', load)}><RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''} />Refresh reports</button><button className="button primary compact" disabled={!!busy} onClick={() => void publish()}>{busy === 'publish' ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}Publish aggregate pack</button></div>
        <p className="publisher-policy">Publication keeps only consented, approved, eligible lots and applies contributor bounds and group-diversity safeguards. A review decision does not guarantee inclusion.</p>
        {reports.length >= 2 && <details className="comparison-label-panel" open={labelMode} onToggle={event => setLabelMode(event.currentTarget.open)}><summary>Review a comparison example <ChevronDown size={16} /></summary>
          <p className="small muted">Compare the products and sale terms, without using similar prices as your criterion. These labels enter a separate, evaluated training process.</p>
          <form className="comparison-label-form" onSubmit={labelComparison}>
            <Field label="Left source report"><select required value={leftReportId} onChange={event => setLeftReportId(event.target.value)}><option value="">Choose evidence</option>{reports.map((report, index) => <option value={report.id} key={report.id}>Evidence {index + 1}</option>)}</select></Field>
            <Field label="Right source report"><select required value={rightReportId} onChange={event => setRightReportId(event.target.value)}><option value="">Choose evidence</option>{reports.map((report, index) => <option value={report.id} key={report.id}>Evidence {index + 1}</option>)}</select></Field>
            <div className="annotation-description"><span className="eyebrow">Left evidence</span><p>{reports.find(report => report.id === leftReportId)?.description || 'Choose evidence to inspect its price-free description.'}</p></div>
            <div className="annotation-description"><span className="eyebrow">Right evidence</span><p>{reports.find(report => report.id === rightReportId)?.description || 'Choose evidence to inspect its price-free description.'}</p></div>
            <Field label="Judgment"><select value={comparisonLabel} onChange={event => setComparisonLabel(event.target.value)}><option value="unknown">Unknown / insufficient evidence</option><option value="comparable">Sufficiently comparable</option><option value="non_comparable">Not comparable</option></select></Field>
            <Field label="Evidence and rationale"><textarea required rows={2} value={comparisonReason} onChange={event => setComparisonReason(event.target.value)} /></Field>
            <button className="button outline compact" type="submit" disabled={!!busy}>{busy === 'label' && <LoaderCircle className="spin" size={15} />}Record comparison label</button>
          </form>
        </details>}
        {!reports.length && <div className="empty-records"><FileText size={30} /><h3>No source reports yet</h3><p>Record and upload a fictional sale from the farmer workspace, then refresh.</p></div>}
        {!labelMode && <div className="review-report-list">{reports.map(report => <article className="review-report" key={report.id}>
          <div className="review-report-heading"><div><span className="eyebrow">{report.id}</span><h2>{report.contributorId}</h2></div><span className={`status-pill ${report.reviewState === 'approved' ? 'success' : ''}`}>{report.reviewState}</span></div>
          <blockquote>{report.rawText || report.description || 'No description provided.'}</blockquote>
          <div className="review-facts">
            <dl><div><dt>Crop</dt><dd>{text(report.context.cropId, factValue(report.facts.cropId))}</dd></div><div><dt>Market</dt><dd>{text(report.context.marketAreaId, factValue(report.facts.marketAreaId))}</dd></div><div><dt>Date</dt><dd>{text(report.context.date, factValue(report.facts.saleDate))}</dd></div></dl>
            <dl><div><dt>Crop amount</dt><dd>{text(report.money.amount, factValue(report.facts.cropConsideration))} {text(report.money.currency, factValue(report.facts.currency))}</dd></div><div><dt>Basis</dt><dd>{text(report.money.basis, factValue(report.facts.priceBasis))}</dd></div><div><dt>Weight</dt><dd>{text(report.money.quantityKg, factValue(report.facts.quantityKg))} kg</dd></div><div><dt>Crop charges</dt><dd>{text(report.money.cropCharges, factValue(report.facts.saleCosts))}</dd></div><div><dt>Loan settlement</dt><dd>{text(report.money.loanSettlement, factValue(report.facts.loanSettlement))}</dd></div></dl>
          </div>
          {report.observations.length > 0 && <details className="evidence-details"><summary>Source-linked observations<ChevronDown size={16} /></summary><ul>{report.observations.map((observation, index) => <li key={text(observation.id, String(index))}>{text(observation.statement)} <span className="muted">({text(observation.status)}, {text(observation.polarity)})</span></li>)}</ul></details>}
          <details className="evidence-details"><summary>Correct the interpreted evidence <ChevronDown size={16} /></summary><p className="small muted">Original source text stays available. Explain any correction in your review reason.</p><div className="form-grid">
            <Field label="Price-free description" wide><textarea rows={2} value={corrections[report.id]?.descriptionText ?? report.description} onChange={event => changeCorrection(report.id, 'descriptionText', event.target.value)} /></Field>
            <Field label={`Crop amount (${text(report.money.basis, factValue(report.facts.priceBasis))})`}><input type="number" min="0" step="any" value={corrections[report.id]?.amount ?? text(report.money.amount, factValue(report.facts.priceBasis) === 'per_kg' ? factValue(report.facts.quotedUnitPrice) : factValue(report.facts.cropConsideration))} onChange={event => changeCorrection(report.id, 'amount', event.target.value)} /></Field>
            <Field label="Crop charges (whole lot)"><input type="number" min="0" step="any" value={corrections[report.id]?.cropCharges ?? text(report.money.cropCharges, factValue(report.facts.saleCosts))} onChange={event => changeCorrection(report.id, 'cropCharges', event.target.value)} /></Field>
          </div></details>
          <p className="small muted">{report.evidenceCount} private attachment reference{report.evidenceCount === 1 ? '' : 's'}{report.includedVersion && ` · Included in ${report.includedVersion}`}</p>
          {report.evidenceIds.length > 0 && <div className="attachment-inspection">{report.evidenceIds.map((id, index) => <button className="button outline compact" key={id} disabled={!!busy} onClick={() => void inspectAttachment(id)}>Inspect private image {index + 1}</button>)}</div>}
          <div className="review-decision"><Field label="Review reason"><textarea rows={2} value={reasons[report.id] ?? ''} onChange={event => setReasons(previous => ({ ...previous, [report.id]: event.target.value }))} placeholder="What evidence supports or contradicts this report? An unusual price alone is not a reason to reject." /></Field>
            <Field label="Corroboration"><select value={verifications[report.id] ?? 'seller_reported'} onChange={event => setVerifications(previous => ({ ...previous, [report.id]: event.target.value }))}><option value="seller_reported">Seller reported</option><option value="receipt_attached">Receipt attached</option><option value="cooperative_attested">Cooperative attested</option></select></Field>
            <div className="review-actions"><button className="button primary compact" disabled={!!busy || !reasons[report.id]?.trim()} onClick={() => void review(report, 'approved')}><CheckCircle2 size={15} />Approve</button><button className="button outline compact" disabled={!!busy || !reasons[report.id]?.trim()} onClick={() => void review(report, 'rejected')}>Reject</button><button className="button subtle compact" disabled={!!busy || !reasons[report.id]?.trim()} onClick={() => void review(report, 'withdrawn')}>Withdraw</button>{busy === report.id && <LoaderCircle size={17} className="spin" />}</div>
          </div>
        </article>)}</div>}
      </>}
    </main>
    {imagePreview && <dialog ref={imageDialog} className="evidence-image-dialog" onCancel={() => setImagePreview(undefined)}>
      <div><strong>Private fictional evidence</strong><button className="button outline compact" autoFocus onClick={() => setImagePreview(undefined)}>Close image</button></div>
      <img src={imagePreview.url} alt="Privately submitted fictional sale evidence" />
      <p className="small muted">Opened through the protected reviewer API. This image has no anonymous source URL.</p>
    </dialog>}
  </div>;
}
