import { z } from 'zod';

// Attestation-only Ed25519 key, domain-separated from the Swap journal key.
// This is NOT an EVM key and cannot authorize permits, orders or transactions.
export const TERMINAL_RELEASE_KEY = '9dff15b1398ab68af8e6e747498b2f48ae4bec1de80990e494dcaaed645f92f6';
const hex32=z.string().regex(/^[0-9a-f]{64}$/);
const uint=z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
export const terminalReleasePayloadSchema=z.object({
  version:z.literal(1),purpose:z.literal('harbor-unused-terminal-release'),binding:hex32,
  chainId:z.literal(137),state:z.literal('expired'),noOrder:z.literal(true),
  token:z.string().regex(/^0x[0-9a-f]{40}$/),nonce:uint,deadline:z.number().int().positive().safe(),
  blockNumber:uint,blockHash:z.string().regex(/^0x[0-9a-f]{64}$/),blockTimestamp:uint,
}).strict();
export const terminalReleaseSchema=z.object({payload:terminalReleasePayloadSchema,signature:z.string().regex(/^[0-9a-f]{128}$/)}).strict();
export type TerminalReleasePayload=z.infer<typeof terminalReleasePayloadSchema>;
export function terminalReleaseMessage(p:TerminalReleasePayload):string {
  return JSON.stringify([p.version,p.purpose,p.binding,p.chainId,p.state,p.noOrder,p.token,p.nonce,p.deadline,p.blockNumber,p.blockHash,p.blockTimestamp]);
}
export function terminalReleaseIdentity(id:string,account:string):string {
  z.string().uuid().parse(id);z.string().regex(/^0x[0-9a-f]{40}$/).parse(account);
  return `harbor-unused-terminal-release:v1:${id}:${account}`;
}
export async function terminalReleaseBinding(id:string,account:string):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(terminalReleaseIdentity(id,account)));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
const bytes=(hex:string)=>new Uint8Array(hex.match(/../g)!.map(b=>parseInt(b,16)));
export async function verifyTerminalRelease(input:unknown,binding:string,key=TERMINAL_RELEASE_KEY):Promise<TerminalReleasePayload> {
  const c=terminalReleaseSchema.parse(input);
  if(c.payload.binding!==binding || BigInt(c.payload.blockTimestamp)<=BigInt(c.payload.deadline))throw new Error('Terminal release identity or expiry mismatch');
  const publicKey=await crypto.subtle.importKey('raw',bytes(hex32.parse(key)),{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,bytes(c.signature),new TextEncoder().encode(terminalReleaseMessage(c.payload))))throw new Error('Invalid terminal release attestation');
  return c.payload;
}
