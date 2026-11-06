// Private out-of-band evidence: never attach raw responses/causes to HTTP errors.
import type { PublicationDiagnostic } from '../server/fusion-publication-diagnostics.js';
import type { ProtectedPublicationResponse } from '../server/fusion-publication-evidence.js';
export type QuotePhase='provider-read'|'quote-schema'|'quote-input'|'auto-limit'|'quote-cost'|'quote-auction';
export interface ProviderReadEvidence {
  endpoint:'quote'|'status'; elapsedMs:number;
  diagnostic:PublicationDiagnostic; response?:ProtectedPublicationResponse;
}
export interface QuoteFailureEvidence {
  phase:QuotePhase;provider?:ProviderReadEvidence;autoK?:number;
}
const reads=new WeakMap<object,ProviderReadEvidence>();
const quotes=new WeakMap<object,QuoteFailureEvidence>();
export function retainProviderRead(error:object,evidence:ProviderReadEvidence){reads.set(error,structuredClone(evidence));}
export function retainQuoteFailure(error:unknown,phase:QuotePhase,autoK?:number,provider?:ProviderReadEvidence){
  if(typeof error!=='object'||error===null)return;
  const read=reads.get(error)??provider;
  quotes.set(error,{phase,...(read?{provider:structuredClone(read)}:{}),
    ...(typeof autoK==='number'&&Number.isFinite(autoK)&&autoK>=0&&autoK<=100?{autoK}:{})});
}
export function readQuoteFailure(error:unknown):QuoteFailureEvidence|undefined {
  if(typeof error!=='object'||error===null)return;
  const value=quotes.get(error);return value?structuredClone(value):undefined;
}
export function withinProviderDeadline<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Provider deadline','TimeoutError'));
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
  });
}
