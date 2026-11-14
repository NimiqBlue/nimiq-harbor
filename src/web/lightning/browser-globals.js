// bolt11's Node dependencies need these globals before module evaluation.
// Keep the shims local and bundled; never load scripts from a CDN.
import { Buffer } from 'buffer';
import process from 'process/browser';
globalThis.Buffer ??= Buffer;
globalThis.process ??= process;
globalThis.global ??= globalThis;
