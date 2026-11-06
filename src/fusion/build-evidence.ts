// Value-free, bounded operator evidence. Never serialized on an HTTP error.
import type { ZodIssue } from 'zod';
export type BuildStage = 'quote-schema'|'quote-input'|'saved-floor'|'permit-encoding'|'sdk-request'|'sdk-create'|'sdk-deadline'|'sdk-build'|'sdk-domain'|'sdk-net-output'|'local-validation'|'sdk-extension';
export type BuildAssertion = 'saved-floor-invalid'|'net-output-nonpositive'|'net-output-below-saved-floor';
type Shape = 'missing'|'null'|'array'|'object'|'string'|'number'|'boolean'|'bigint'|'other';
export interface MinimumComparison {
  protectedMinimumRaw:string;sdkNetMinimumRaw:string;shortfallRaw:string;
  // Positive shortfall relative to the protected floor; truncated to 8 decimals.
  shortfallPercent:string;slippageBps:number;
}
export interface BuildEvidence {stage:BuildStage;assertion?:BuildAssertion;schema?:Array<{path:string;shape:Shape}>;minimumComparison?:MinimumComparison}
export function minimumComparison(floor:bigint,net:bigint,slippageBps:number):MinimumComparison {
  if(floor<=0n||net<0n||floor.toString().length>78||net.toString().length>78||!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>10000)throw new Error('Invalid minimum comparison');
  const shortfall=floor>net?floor-net:0n;
  const scaled=shortfall*10000000000n/floor;
  return {protectedMinimumRaw:floor.toString(),sdkNetMinimumRaw:net.toString(),shortfallRaw:shortfall.toString(),shortfallPercent:`${scaled/100000000n}.${(scaled%100000000n).toString().padStart(8,'0')}`,slippageBps};
}
const stages = new Set<BuildStage>(['quote-schema','quote-input','saved-floor','permit-encoding','sdk-request','sdk-create','sdk-deadline','sdk-build','sdk-domain','sdk-net-output','local-validation','sdk-extension']);
const assertions = new Set<BuildAssertion>(['saved-floor-invalid','net-output-nonpositive','net-output-below-saved-floor']);
const shapes = new Set<Shape>(['missing','null','array','object','string','number','boolean','bigint','other']);
const fields=new Set('fromTokenAmount toTokenAmount marketAmount recommended_preset presets fast medium slow prices volume usd fromToken toToken settlementAddress whitelist quoteId autoK fee receiver bps whitelistDiscountPercent surplusFee integratorFee integratorFeeShare source auctionDuration startAuctionIn bankFee initialRateBump auctionStartAmount auctionEndAmount tokenFee points delay coefficient allowPartialFills allowMultipleFills exclusiveResolver gasCost gasBumpEstimate gasPriceEstimate'.split(' '));
const evidence=new WeakMap<object,BuildEvidence>();
export function retainBuildEvidence(error:unknown,stage:BuildStage,assertion?:BuildAssertion,schema?:BuildEvidence['schema'],comparison?:{floor:bigint;net:bigint;slippageBps:number}) {
  if ((typeof error!=='object' && typeof error!=='function') || error===null || !stages.has(stage)) return;
  if(evidence.has(error))return;
  const safe:BuildEvidence={stage};
  if(assertion && assertions.has(assertion))safe.assertion=assertion;
  if(schema)safe.schema=schema.slice(0,32).filter(s=>typeof s.path==='string' && s.path.length<=180 && s.path.split('.').every(p=>p==='*'||fields.has(p)) && shapes.has(s.shape)).map(s=>({path:s.path,shape:s.shape}));
  if(comparison && stage==='local-validation' && (assertion==='net-output-below-saved-floor'||assertion==='net-output-nonpositive')) {
    try {safe.minimumComparison=minimumComparison(comparison.floor,comparison.net,comparison.slippageBps);} catch { /* malformed diagnostics must not replace the original failure */ }
  }
  evidence.set(error,safe);
}
export function readBuildEvidence(error:unknown):BuildEvidence|undefined {
  if(typeof error!=='object'||error===null)return;
  const value=evidence.get(error);return value?structuredClone(value):undefined;
}
export function schemaShapes(input:unknown,issues:ZodIssue[]):NonNullable<BuildEvidence['schema']> {
  const found=new Map<string,{path:string;shape:Shape}>();
  for(const issue of issues) {
    if(issue.path.some(p=>typeof p!=='number' && !fields.has(String(p))))continue;
    const path=issue.path.map(p=>typeof p==='number'?'*':p).join('.');
    let value:unknown=input;
    for(const part of issue.path)value=value!==null && typeof value==='object' ? (value as Record<string,unknown>)[String(part)] : undefined;
    const shape:Shape=value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':(['object','string','number','boolean','bigint'].includes(typeof value)?typeof value:'other') as Shape;
    if(!found.has(path))found.set(path,{path,shape});
    if(found.size===32)break;
  }
  return [...found.values()];
}
