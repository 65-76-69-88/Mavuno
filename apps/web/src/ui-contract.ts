/** UI-facing contracts. Services keep model, pack and persistence details out of components. */
import type { SaleFacts } from '@pricemesh/domain';
export type { SaleFacts } from '@pricemesh/domain';
export type Language = 'en' | 'fr' | 'sw';
export type Persona = 'farmer-a' | 'farmer-b';

export interface InstallationState {
  ready: boolean;
  phase: string;
  /** Installation percentage in [0, 100], when measurable. */
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export interface PackSummary {
  version: string;
  asOf: string;
  validUntil: string;
  bytes?: number;
  lastUpdated?: string;
}

export interface ParsedOffer {
  facts: SaleFacts;
  lotDescription: string;
  issues: string[];
}

export interface Comparison {
  outcome: 'compared' | 'clarify' | 'abstain';
  title: string;
  explanation: string;
  nextStep: string;
  limitations: string[];
  exclusions: string[];
  coverage: string[];
  cohortLabel?: string;
  median?: number;
  q25?: number;
  q75?: number;
  offer?: number;
  deltaPct?: number;
  currency?: string;
  packVersion?: string;
  observationWindow?: string;
  inferenceMs?: number;
  cashReceived?: number;
}

export interface PersonalRecord {
  id: string;
  facts: SaleFacts;
  description: string;
  language: Language;
  createdAt: string;
  consent: { upload: boolean; aggregateUse: boolean };
  outbox: 'local' | 'queued' | 'uploading' | 'uploaded';
  reviewState: 'unreviewed' | 'approved' | 'rejected' | 'withdrawn';
  includedVersion?: string;
  error?: string;
}

export interface AppSnapshot {
  installation: InstallationState;
  pack?: PackSummary;
  records: PersonalRecord[];
}

export interface ClientService {
  snapshot(persona: Persona): Promise<AppSnapshot>;
  install(onProgress: (state: InstallationState) => void): Promise<void>;
  interpret(text: string, language: Language): Promise<ParsedOffer>;
  compare(facts: SaleFacts, lotDescription: string, language: Language): Promise<Comparison>;
  saveSale(persona: Persona, sale: {
    facts: SaleFacts;
    description: string;
    /** User-reviewed, price-free evidence; original description remains source text. */
    lotDescription?: string;
    language: Language;
    consent: { upload: boolean; aggregateUse: boolean };
    attachment?: File;
  }): Promise<PersonalRecord>;
  sync(persona: Persona): Promise<void>;
  updatePack(): Promise<{ updated: boolean; version: string }>;
}
