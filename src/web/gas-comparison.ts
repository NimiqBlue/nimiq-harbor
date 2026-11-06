export type GasComparison = 'success' | 'http-error' | 'rpc-error' | 'invalid-response' | 'timeout' | 'unavailable';

// Explicit opt-in only: the RPC sees the complete unsigned transfer call. Never use
// this result as gas for a transaction or include request/response data in telemetry.
export async function compareGasEstimate(url: string, params: unknown[], fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<GasComparison> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<GasComparison> => {
    try {
      const response = await fetcher(url, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas', params }), signal: controller.signal });
      if (!response.ok) return 'http-error';
      if (!response.body) return 'invalid-response';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { void reader.cancel().catch(() => {}); return 'invalid-response'; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'invalid-response'; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid-response';
      const b = body as Record<string, unknown>;
      if (b.jsonrpc !== '2.0' || b.id !== 1) return 'invalid-response';
      if (Object.hasOwn(b, 'result') && !Object.hasOwn(b, 'error') && typeof b.result === 'string' && /^0x[0-9a-f]+$/i.test(b.result) && BigInt(b.result) > 0n) return 'success';
      if (!Object.hasOwn(b, 'result') && b.error && typeof b.error === 'object' && !Array.isArray(b.error) && Number.isInteger((b.error as {code?: unknown}).code)) return 'rpc-error';
      return 'invalid-response';
    } catch { return controller.signal.aborted ? 'timeout' : 'unavailable'; }
  };
  try {
    return await Promise.race([work(), new Promise<GasComparison>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
