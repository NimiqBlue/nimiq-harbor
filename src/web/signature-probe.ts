import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { authorizedAccount, type HarborProvider } from './wallet';
import { readDiagnosticPermit, assertDiagnosticPermit, type PermitToken } from './permit-diagnostic';

export const SIGNATURE_PROBE_TIMEOUT_MS = 60_000;
export type ProbeStage = 'checking wallet account and network' | 'waiting for wallet signature' | 'checking returned signature';
export type ProbeStep = 'preflight-account' | 'preflight-chain' | 'signature' | 'postflight-account' | 'postflight-chain' | 'recovery' | 'permit-read';
export type ProbeDiagnostic = { step: ProbeStep; state: 'pending' | 'complete' | 'failed'; code?: number };
export const PROBE_STEP_LABELS: Record<ProbeStep, string> = {
  'permit-read': 'Read token nonce and verify exact domain · read-only RPC',
  'preflight-account': 'Read account · eth_accounts', 'preflight-chain': 'Read network · eth_chainId',
  signature: 'Request EIP-712 signature · eth_signTypedData_v4',
  'postflight-account': 'Recheck account · eth_accounts', 'postflight-chain': 'Recheck network · eth_chainId',
  recovery: 'Verify signature locally',
};
// Return numeric metadata only; never render a provider message/data/stack.
export function signatureProbeCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && Number.isSafeInteger(code) && code >= -32768 && code <= 49999 ? code : undefined;
}
export class SignatureProbeError extends Error {}
let diagnosticInFlight = false;
export function signatureProbeError(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return 'Signature test declined. No transaction was sent.';
  if (code === 4200 || code === -32601) return 'This wallet does not support eth_signTypedData_v4. Update Nimiq Pay and reconnect before retrying. No transaction was sent.';
  if (code === -32602) return 'The wallet rejected the EIP-712 request parameters. Update Nimiq Pay and reconnect before retrying. No transaction was sent.';
  if (code === 4100 || code === 4900 || code === 4901) return 'Wallet connection unavailable or not authorized. Unlock Nimiq Pay and reconnect before retrying. No transaction was sent.';
  // Only show our own diagnostic messages, never arbitrary provider payloads/signatures.
  if (error instanceof SignatureProbeError) return `${error.message} No transaction was sent.`;
  return 'Signature test not verified. The wallet could not complete this request. Unlock Nimiq Pay, dismiss any open signature prompt and reconnect before retrying. No transaction was sent.';
}

// Deliberately NOT a token permit or an executable order. No spender, value,
// token address or contract domain; signatures never leave this function.
export function probeData(account: Hex, chainId: number, nonce: Hex, now: number) {
  return {
    domain: { name: 'Nimiq Harbor compatibility test', version: '1', chainId },
    primaryType: 'HarborCompatibility' as const,
    types: { HarborCompatibility: [
      { name: 'purpose', type: 'string' }, { name: 'wallet', type: 'address' },
      { name: 'nonce', type: 'bytes32' }, { name: 'expiresAt', type: 'uint256' },
    ] },
    message: { purpose: 'Signature compatibility only. No token approval, no order, no transfer.', wallet: account, nonce, expiresAt: String(now + 300) },
  };
}
export async function checkTypedSignature(provider: HarborProvider, expectedAccount: Hex, expectedChain: number, options: {
  signal?: AbortSignal; timeoutMs?: number; onProgress?: (stage: ProbeStage) => void; onDiagnostic?: (event: ProbeDiagnostic) => void;
  permitToken?: PermitToken;
} = {}) {
  if (diagnosticInFlight) throw new SignatureProbeError('Another signature diagnostic is in progress. Finish or dismiss its wallet prompt first.');
  diagnosticInFlight = true;
  let stage: ProbeStage = 'checking wallet account and network';
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(new SignatureProbeError('Wallet session changed. Signature test not verified. Reconnect before retrying.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeoutMs = options.timeoutMs ?? SIGNATURE_PROBE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const timeout = () => cancellation.abort(new SignatureProbeError(`Signature test timed out while ${stage}. A wallet prompt may still be open; dismiss it before retrying.`));
  const timer = setTimeout(timeout, timeoutMs);
  const assertActive = () => {
    // WebView timers can be throttled while native confirmation is foregrounded.
    if (!cancellation.signal.aborted && Date.now() >= deadline) timeout();
    if (cancellation.signal.aborted) throw cancellation.signal.reason;
  };
  // Expire even a still-unanswered native request on resume, without waiting
  // for throttled background timers or a late bridge reply.
  const resume = () => { if (Date.now() >= deadline) timeout(); };
  if (typeof window !== 'undefined') window.addEventListener('focus', resume);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume);
  // Race each await, not only the outer operation: a late preflight must NEVER
  // continue into a signing prompt after the UI has reported a timeout/cancel.
  const pendingSteps: ProbeStep[] = [];
  const bounded = async <T,>(step: ProbeStep, operation: () => T | Promise<T>): Promise<T> => {
    assertActive(); pendingSteps.push(step); options.onDiagnostic?.({ step, state: 'pending' });
    assertActive(); // UI callbacks may synchronously invalidate the session.
    let listener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      listener = () => reject(cancellation.signal.reason);
      cancellation.signal.addEventListener('abort', listener, { once: true });
    });
    try {
      const value = await Promise.race([operation(), aborted]);
      assertActive(); options.onDiagnostic?.({ step, state: 'complete' }); return value;
    } catch (error) {
      const code = signatureProbeCode(error);
      options.onDiagnostic?.({ step, state: 'failed', ...(code !== undefined ? { code } : {}) }); throw error;
    } finally {
      cancellation.signal.removeEventListener('abort', listener);
      pendingSteps.pop();
      // Nested account/chain guards must not hide the outer token RPC wait.
      const parent = pendingSteps.at(-1);
      if (parent && !cancellation.signal.aborted) options.onDiagnostic?.({ step: parent, state: 'pending' });
    }
  };
  const request = (step: ProbeStep, args: Parameters<HarborProvider['request']>[0]) => bounded(step, () => provider.request(args));
  const snapshot = async (postflight = false) => {
    const account = authorizedAccount(await request(postflight ? 'postflight-account' : 'preflight-account', { method: 'eth_accounts' }), expectedAccount);
    const chain = await request(postflight ? 'postflight-chain' : 'preflight-chain', { method: 'eth_chainId' });
    if (!account || getAddress(account) !== getAddress(expectedAccount) || typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(expectedChain)) throw new SignatureProbeError('Wallet account or network changed. Reconnect before retrying.');
  };
  try {
    if (!Number.isSafeInteger(expectedChain) || expectedChain <= 0) throw new SignatureProbeError('Wallet network is not ready. Reconnect before retrying.');
    assertActive(); options.onProgress?.(stage);
    await snapshot();
    const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}` as Hex;
    const started = Math.floor(Date.now() / 1000);
    if (options.permitToken && expectedChain !== 137) throw new SignatureProbeError('Select Polygon before testing token schemas.');
    const permit = options.permitToken ? await bounded('permit-read', () => readDiagnosticPermit(options.permitToken!, expectedAccount, snapshot)) : null;
    if (permit) await snapshot();
    const data = permit?.data ?? probeData(expectedAccount, expectedChain, nonce, started);
    if (permit && options.permitToken) assertDiagnosticPermit(permit.data, options.permitToken, expectedAccount, permit.nonce);
    stage = 'waiting for wallet signature'; options.onProgress?.(stage);
    // Official Nimiq provider API: [address, JSON-stringified typed data], NOT
    // the native bridge's {raw,address} object. No fallback to personal_sign.
    const signature = await request('signature', { method: 'eth_signTypedData_v4', params: [expectedAccount, JSON.stringify(data)] });
    stage = 'checking returned signature'; options.onProgress?.(stage);
    await snapshot(true);
    if (permit && options.permitToken) {
      const fresh = await bounded('permit-read', () => readDiagnosticPermit(options.permitToken!, expectedAccount, () => snapshot(true)));
      await snapshot(true);
      if (fresh.nonce !== permit.nonce) throw new SignatureProbeError('Token nonce changed. Diagnostic not verified. Retry when ready.');
      assertDiagnosticPermit(permit.data, options.permitToken, expectedAccount, fresh.nonce);
    }
    if (Date.now() / 1000 > started + 300) throw new SignatureProbeError('Signature test expired. Retry when ready.');
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new SignatureProbeError('Wallet returned an unsupported signature format.');
    const recovered = await bounded('recovery', () => permit
      ? recoverTypedDataAddress({ ...permit.data, types: { Permit: permit.data.types.Permit }, message: { ...permit.data.message, value: 0n, nonce: permit.nonce, deadline: 1n }, signature: signature as Hex })
      : recoverTypedDataAddress({ ...probeData(expectedAccount, expectedChain, nonce, started), signature: signature as Hex }));
    assertActive();
    if (getAddress(recovered) !== getAddress(expectedAccount)) throw new SignatureProbeError('Signature does not match the connected account.');
    return { verified: true as const, chainId: expectedChain, checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    diagnosticInFlight = false;
    if (typeof window !== 'undefined') window.removeEventListener('focus', resume);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume);
  }
}
