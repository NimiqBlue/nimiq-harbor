// Operator-only, stored exclusively in the existing AES-GCM execution payload.
// No headers, request body, raw exceptions, plaintext column or public projection.
export interface ProtectedPublicationResponse {
  version:1; bodyJson:string; redacted:boolean;
}
const LIMIT=8192;
export function protectedPublicationResponse(parsed:unknown,reflections:readonly string[]=[]):ProtectedPublicationResponse {
  let redacted=false;
  const replace=(text:string,pattern:RegExp,replacement:string)=>text.replace(pattern,()=>{redacted=true;return replacement;});
  function clean(text:string):string {
    // Exact known request secrets first (also catches short opaque API keys).
    for(const value of reflections.filter(v=>v.length>=4).sort((a,b)=>b.length-a.length)) {
      if(text.toLowerCase().includes(value.toLowerCase())) {
        const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        text=replace(text,new RegExp(escaped,'gi'),'[REDACTED]');
      }
    }
    text=replace(text,/\bBearer\s+[^\s,;"']+/gi,'Bearer [REDACTED]');
    text=replace(text,/https?:\/\/[^\s"']+/gi,'[REDACTED_URL]');
    text=replace(text,/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[REDACTED_EMAIL]');
    text=replace(text,/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gi,'[REDACTED_IBAN]');
    text=replace(text,/\bNQ\d{2}(?:[ -]?[A-Z0-9]){32}\b/gi,'[REDACTED_WALLET]');
    text=replace(text,/\b0x[0-9a-f]+\b/gi,'[REDACTED_HEX]');
    text=replace(text,/\b(?:signature|permit|extension|authorization|cookie|password|secret|(?:access|refresh|api)[_-]?token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'[REDACTED_SECRET]');
    // JWTs, signatures, base64 and opaque token strings, even in free prose.
    text=replace(text,/[A-Za-z0-9_+/~.=-]{24,}/g,'[REDACTED_TOKEN]');
    return Array.from(text,char=>{const code=char.charCodeAt(0);return code<32 || code===127?' ':char;}).join('');
  }
  function visit(value:unknown,depth=0):unknown {
    if(depth>12){redacted=true;return '[DEPTH_LIMIT]';}
    if(typeof value==='string')return clean(value);
    if(Array.isArray(value))return value.map(v=>visit(v,depth+1));
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[
      clean(key), /signature|permit|extension|authorization|cookie|password|secret|token|api.?key|iban|email|wallet|address/i.test(key)
        ? (redacted=true,'[REDACTED]'):visit(v,depth+1),
    ]));
    return value;
  }
  const bodyJson=JSON.stringify(visit(parsed));
  // JSON escaping/redaction can expand input. Bound persisted output too.
  if(Buffer.byteLength(bodyJson)>LIMIT)return {version:1,bodyJson:JSON.stringify({description:'[REDACTED_OUTPUT_LIMIT]'}),redacted:true};
  return {version:1,bodyJson,redacted};
}
