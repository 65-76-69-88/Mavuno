import { evidenceRecordSchema, fact, parseExactFacts, preprocessDescription } from '@pricemesh/domain';
import type { EvidenceRecord, SaleFacts } from '@pricemesh/domain';
import type { StoredReport } from './store.js';
import { z } from 'zod';

export const evidenceUploadSchema=evidenceRecordSchema.omit({id:true,reviewState:true,attachmentRefs:true,verification:true,reviews:true})
  .extend({clientReportId:z.string().min(16).max(128),rawText:z.string().max(16_000),descriptionText:z.string().max(16_000),
    observations:evidenceRecordSchema.shape.observations.max(100),synthetic:z.literal(true),
    consent:z.object({upload:z.literal(true),aggregateUse:z.boolean(),recordedAt:z.string().datetime()}).strict(),
    id:z.string().optional(),reviewState:z.enum(['unreviewed','approved','rejected','withdrawn']).optional(),attachmentRefs:z.array(z.string()).optional(),
    verification:evidenceRecordSchema.shape.verification,reviews:evidenceRecordSchema.shape.reviews}).strict()
  .refine(record=>new Set(record.observations.map(observation=>observation.id)).size===record.observations.length,
    {message:'Observation IDs must be unique within a report.',path:['observations']});

/** Legacy normalized facts remain an internal arithmetic bridge; open observations are retained independently. */
export function factsFromEvidence(record:EvidenceRecord):SaleFacts {
  const facts=parseExactFacts(record.descriptionText,{language:record.language}).facts;
  const status=record.context.status==='confirmed'?'confirmed':'reported';
  if(record.context.cropId) facts.cropId=fact(record.context.cropId,status,record.context.sourceRefs??[]);
  if(record.context.marketAreaId) facts.marketAreaId=fact(record.context.marketAreaId,status,record.context.sourceRefs??[]);
  if(record.context.date) facts.saleDate=fact(record.context.date,status,record.context.sourceRefs??[]);
  if(record.context.marketTier) facts.saleChannel=fact(record.context.marketTier,status,record.context.sourceRefs??[]);
  const money=record.money;
  if(money) {
    const moneyStatus=money.status==='confirmed'?'confirmed':'reported';
    facts.currency=fact(money.currency,moneyStatus,money.sourceRefs);facts.priceBasis=fact(money.basis,moneyStatus,money.sourceRefs);
    facts[money.basis==='per_kg'?'quotedUnitPrice':'cropConsideration']=fact(money.amount,moneyStatus,money.sourceRefs);
    if(money.quantityKg) facts.quantityKg=fact(money.quantityKg,moneyStatus,money.sourceRefs);
    if(money.sourceQuantity) facts.sourceQuantity=fact(money.sourceQuantity,moneyStatus,money.sourceRefs);
    if(money.sourceUnit) facts.sourceUnit=fact(money.sourceUnit,moneyStatus,money.sourceRefs);
    if(money.cropCharges!==undefined) facts.saleCosts=fact(money.cropCharges,moneyStatus,money.sourceRefs);
    if(money.loanSettlement!==undefined) facts.loanSettlement=fact(money.loanSettlement,moneyStatus,money.sourceRefs);
  }
  return facts;
}
export function uploadFromEvidence(input:z.infer<typeof evidenceUploadSchema>):Omit<StoredReport,'id'|'reviewState'|'verification'|'reviews'|'evidenceRefs'> {
  const prepared=preprocessDescription(input.descriptionText);
  const record:EvidenceRecord={...input,id:'pending-server-id',attachmentRefs:[],reviewState:'unreviewed',
    verification:'seller_reported',reviews:[],descriptionText:prepared.description};
  return {clientReportId:record.clientReportId,contributorId:record.contributorId,cooperativeId:record.custodianId,lotId:record.lotId,
    facts:factsFromEvidence(record),originalText:record.rawText,inputLanguage:record.language,consent:record.consent,synthetic:true,evidenceRecord:record};
}
