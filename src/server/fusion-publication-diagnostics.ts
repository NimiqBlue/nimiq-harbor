// Finite compatibility diagnostic; optional protected capture is encrypted only.
import { protectedPublicationResponse, type ProtectedPublicationResponse } from './fusion-publication-evidence.js';
export const PUBLICATION_BODY_LIMIT=8192;
const ERROR_CODES=['INVALID_SIGNATURE','ORDER_NOT_FOUND','INVALID_ORDER','INVALID_QUOTE_ID','ORDER_ALREADY_EXISTS','QUOTE_EXPIRED'] as const;
type ErrorCode=typeof ERROR_CODES[number];
export type PublicationDiagnostic =
  | {outcome:'timeout'|'transport';at:number}
  | {outcome:'http';httpStatus:number;at:number;body:'empty'|'json'|'unrecognized'|'too-large'|'read-failure'|'timeout';errorCode?:ErrorCode};

function timeout(error:unknown,signal:AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name==='TimeoutError');
}
/** Bound even a stalled body; cancellation is best-effort, never awaited. */
function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Publication deadline','TimeoutError'));
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
  });
}
function cancel(reader:ReadableStreamDefaultReader<Uint8Array>) {
  try{void reader.cancel().catch(()=>{});}catch{/* cancellation cannot erase HTTP evidence */}
}
async function bodyEvidence(response:Response,signal:AbortSignal,capture?:{save:(e:ProtectedPublicationResponse)=>void;reflections:readonly string[]}):Promise<Pick<Extract<PublicationDiagnostic,{outcome:'http'}>,'body'|'errorCode'>> {
  if(!response.body)return {body:'empty'};
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    reader=response.body.getReader();
    const bytes=new Uint8Array(PUBLICATION_BODY_LIMIT);let size=0;
    for(;;) {
      const {done,value}=await bounded(reader.read(),signal);
      if(done)break;
      if(value.byteLength>PUBLICATION_BODY_LIMIT-size)return {body:'too-large'};
      bytes.set(value,size);size+=value.byteLength;
    }
    if(size===0)return {body:'empty'};
    let parsed:unknown;
    try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));}
    catch{return {body:'unrecognized'};}
    if(capture && response.status!==201)capture.save(protectedPublicationResponse(parsed,capture.reflections));
    // Exact top-level machine-code match only: never substring-match a message,
    // copy an upstream description, traverse arbitrary fields or keep a payload.
    if(parsed && typeof parsed==='object' && !Array.isArray(parsed)) {
      const object=parsed as Record<string,unknown>;
      for(const field of ['code','error']) {
        if(!Object.hasOwn(object,field))continue;
        const value=object[field];
        if(typeof value==='string' && ERROR_CODES.some(code=>code===value))return {body:'json',errorCode:value as ErrorCode};
      }
    }
    return {body:'json'};
  }catch(error){return {body:timeout(error,signal)?'timeout':'read-failure'};}
  finally{if(reader)cancel(reader);}
}
/** One physical attempt, caller owns the irreversible claim and exact-revision
 * durable write. 201 alone is provider acceptance, never settlement evidence. */
export async function publicationDiagnostic(send:()=>Promise<Response>,signal:AbortSignal,now:()=>number,capture?:{save:(e:ProtectedPublicationResponse)=>void;reflections:readonly string[]}):Promise<PublicationDiagnostic> {
  let response:Response;
  try{response=await bounded(send(),signal);}
  catch(error){return {outcome:timeout(error,signal)?'timeout':'transport',at:now()};}
  const evidence=await bodyEvidence(response,signal,capture);
  return {outcome:'http',httpStatus:response.status,...evidence,at:now()};
}
