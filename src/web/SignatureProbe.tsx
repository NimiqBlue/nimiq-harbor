import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { checkTypedSignature, PROBE_STEP_LABELS, signatureProbeError, type ProbeDiagnostic, type ProbeStage } from './signature-probe';
import './signature-probe.css';
import { authorizedAccount, type WalletController } from './wallet';
import { permitDefinitions, type PermitToken } from './permit-diagnostic';

type ProbeRun = { provider: NonNullable<WalletController['provider']>; account: NonNullable<WalletController['account']>; chainId: number; controller: AbortController };
const pendingText = (stage: ProbeStage) => `${stage[0]!.toUpperCase()}${stage.slice(1)}… Only the non-spending compatibility message is requested. Timeout: 60 seconds.`;
export type PermitNoticeState = { token: PermitToken; attempt: number; busy: boolean; result: string; signatureReceived: boolean; diagnostic: ProbeDiagnostic | undefined };
export function PermitNotice({ notice, onDismiss }: { notice: PermitNoticeState; onDismiss: () => void }) {
  return <section className="permit-notice" aria-label="Active Permit diagnostic">
    <strong>Permit diagnostic v3 · {notice.token} · Attempt {notice.attempt}</strong>
    <div role="status" aria-live="polite" aria-atomic="true">
      <p>{!notice.busy ? notice.result : notice.signatureReceived ? 'Signature received. Checking wallet and token; not yet verified.' : notice.diagnostic?.step === 'signature' ? 'Waiting for Nimiq Pay. Confirm or decline in the wallet, then return to Harbor.' : 'Checking wallet and token. No spending authorization.'}</p>
      {notice.diagnostic && <small>Step: {PROBE_STEP_LABELS[notice.diagnostic.step]} — {notice.diagnostic.state}{notice.diagnostic.code !== undefined ? ` · RPC code ${notice.diagnostic.code}` : ''}</small>}
    </div>
    {!notice.busy && <button type="button" className="text-button" onClick={onDismiss}>Dismiss permit result</button>}
  </section>;
}
export function SignatureProbe({ wallet, permitToken, onReport }: { wallet: WalletController; permitToken?: PermitToken; onReport?: (notice: PermitNoticeState) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [diagnostics, setDiagnostics] = useState<ProbeDiagnostic[]>([]);
  const [signatureReceived, setSignatureReceived] = useState(false);
  const [switchingNetwork, setSwitchingNetwork] = useState(false);
  const [switchRequested, setSwitchRequested] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const statusId = useId();
  const statusRef = useRef<HTMLDivElement>(null);
  const active = useRef<ProbeRun | null>(null);
  const completed = useRef<ProbeRun | null>(null);
  useEffect(() => {
    const run = active.current;
    if (run) {
      // Opening native confirmation can background the WebView. useWallet
      // deliberately clears its cached account/chain during that interval.
      // Do not erase this operation/result for a temporary null snapshot: the
      // probe independently checks the provider's account+chain before/after.
      if (wallet.provider !== run.provider || (wallet.account && wallet.account.toLowerCase() !== run.account.toLowerCase()) || (wallet.chainId !== null && wallet.chainId !== run.chainId)) run.controller.abort();
    } else {
      const previous = completed.current;
      if (previous && (wallet.provider !== previous.provider || (wallet.account && wallet.account.toLowerCase() !== previous.account.toLowerCase()) || (wallet.chainId !== null && wallet.chainId !== previous.chainId))) {
        completed.current = null;
        setResult('Wallet session changed. Previous signature result is no longer current. Reconnect and run the test again.');
      }
    }
  }, [wallet.account, wallet.chainId, wallet.provider]);
  useEffect(() => {
    const provider = wallet.provider;
    if (!provider) return;
    // Unlike a temporary cache reset on backgrounding, actual EIP-1193 events
    // revoke this operation even if React batches a change away and back.
    const invalidate = () => {
      active.current?.controller.abort();
      if (completed.current) {
        completed.current = null;
        setResult('Wallet session changed. Previous signature result is no longer current. Reconnect and run the test again.');
      }
    };
    const accountsChanged = (accounts: unknown) => {
      const context = active.current ?? completed.current;
      if (context && !authorizedAccount(accounts, context.account)) invalidate();
    };
    const chainChanged = (chain: unknown) => {
      const context = active.current ?? completed.current;
      if (context && (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(context.chainId))) invalidate();
    };
    provider.on?.('accountsChanged', accountsChanged); provider.on?.('chainChanged', chainChanged); provider.on?.('disconnect', invalidate);
    return () => { provider.removeListener?.('accountsChanged', accountsChanged); provider.removeListener?.('chainChanged', chainChanged); provider.removeListener?.('disconnect', invalidate); };
  }, [wallet.provider]);
  useEffect(() => {
    active.current?.controller.abort();
    if (completed.current) {
      completed.current = null;
      setResult('Wallet session changed. Previous signature result is no longer current. Reconnect and run the test again.');
    }
  }, [wallet.selectionRevision]);
  useEffect(() => () => { active.current?.controller.abort(); active.current = null; }, []);
  const wrongPermitNetwork = !!permitToken && wallet.chainId !== null && wallet.chainId !== 137;
  const switchToPolygon = async () => {
    if (switchingNetwork || busy) return;
    setSwitchRequested(true); setSwitchError(''); setSwitchingNetwork(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        wallet.switchPolygon(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Network switch timed out. Return to Harbor and reconnect to check the wallet network. No signature was requested.')), 30_000); }),
      ]);
    } catch (error) { setSwitchError(error instanceof Error ? error.message : 'Could not switch the wallet network.'); }
    finally { clearTimeout(timer); setSwitchingNetwork(false); }
  };
  const readiness = !wallet.provider ? 'Wallet provider unavailable. Open Harbor inside Nimiq Pay and connect again.'
    : !wallet.account ? 'Connect Nimiq Pay first.'
      : !wallet.chainId ? 'Wallet network is not ready. Unlock Nimiq Pay and reconnect.' : wrongPermitNetwork ? `Wallet is on network ${wallet.chainId}, not Polygon (137). Switch the wallet below, then press the Permit test separately. Switching networks does not send a transaction or enable mainnet spending.` : '';
  const run = async () => {
    if (active.current) return; // A visible pending status already explains this state.
    if (!wallet.provider || !wallet.account || !wallet.chainId || wrongPermitNetwork || switchingNetwork) { setResult(readiness); return; }
    const operation: ProbeRun = { provider: wallet.provider, account: wallet.account, chainId: wallet.chainId, controller: new AbortController() };
    active.current = operation; completed.current = null;
    // React batches event updates. Commit feedback BEFORE entering an injected
    // provider: a native modal/background transition may prevent the next paint.
    flushSync(() => {
      setBusy(true); setAttempt(value => value + 1); setDiagnostics([]); setSignatureReceived(false);
      setResult(permitToken ? 'Checking wallet and exact token domain… ZERO value, ZERO spender, deadline 1 (already expired). No spending authorization.' : pendingText('checking wallet account and network'));
    });
    statusRef.current?.scrollIntoView({ block: 'nearest' });
    try {
      await checkTypedSignature(operation.provider, operation.account, operation.chainId, {
        signal: operation.controller.signal,
        ...(permitToken ? { permitToken } : {}),
        onProgress: stage => { if (active.current === operation) flushSync(() => setResult(permitToken ? `${stage}… ${permitToken} Permit schema only: value 0, spender ZERO, deadline 1 (expired). Timeout: 60 seconds.` : pendingText(stage))); },
        onDiagnostic: event => {
          if (active.current === operation) flushSync(() => {
            setDiagnostics(previous => [...previous, event].slice(-12));
            if (event.step === 'signature' && event.state === 'complete') setSignatureReceived(true);
          });
        },
      });
      if (active.current === operation) setResult(permitToken ? `${permitToken} expired zero-value Permit schema signature verified locally. Cannot authorize spending. NOT token permit acceptance, Fusion acceptance or receipt of funds.` : 'Signature verified locally. EIP-712 works for this test message. This does not verify token permits, Fusion execution or receipt of funds.');
    } catch (error) {
      if (active.current === operation) setResult(signatureProbeError(error));
    } finally {
      if (active.current === operation) { active.current = null; completed.current = operation; setBusy(false); }
    }
  };
  const lastDiagnostic = diagnostics.at(-1);
  useEffect(() => {
    if (permitToken && attempt > 0) onReport?.({ token: permitToken, attempt, busy, result, signatureReceived, diagnostic: lastDiagnostic });
  }, [permitToken, attempt, busy, result, signatureReceived, lastDiagnostic, onReport]);
  return <section aria-label={permitToken ? `${permitToken} safe Permit diagnostic` : 'Wallet signature diagnostic'}>
    <h3>{permitToken ? `${permitToken} · safe Permit schema test` : 'Wallet signature diagnostic'}</h3>
    <p className="fine-print">{permitToken ? `Exact ${permitDefinitions[permitToken].name} / ${permitDefinitions[permitToken].version} domain. Permit value 0; spender 0x0000000000000000000000000000000000000000; deadline 1 (1970, expired). Reject any different prompt. This deliberately invalid permit cannot spend and will never be submitted. A wallet may reject it; that is a diagnostic result, not a reason to sign a live permit.` : 'Signs a harmless EIP-712 compatibility message in your wallet. No token approval, order, transfer or gas.'} The signature is checked only in this browser, not stored or sent to Harbor.</p>
    {permitToken && <p className="fine-print">{permitDefinitions[permitToken].address}{permitToken === 'USDT0' && ' · Stored bytes32 Polygon salt 137; no chainId field. Not a fork-only domain.'}</p>}
    {/* Keep the live region outside aria-busy, prominent and ABOVE the action,
        so tapping a bottom-edge button cannot put all feedback offscreen. */}
    <div id={statusId} ref={statusRef} role="status" aria-live="polite" aria-atomic="true" className="signature-probe-status">
      <strong>{busy ? 'Signature test in progress' : attempt ? 'Signature test result' : 'Signature test readiness'}</strong>
      <p>{!busy && readiness ? `${readiness}${result ? ` ${result}` : ''}` : result || 'Ready to test EIP-712. No transaction will be sent.'}</p>
      {!wallet.account && !busy && <p>Connect Nimiq Pay first.</p>}
      <small>{permitToken ? 'Permit diagnostic v3 · Network check v4' : 'Diagnostic v2'} · Attempt {attempt} · Provider {wallet.provider ? 'detected' : 'missing'} · Account {wallet.account ? 'ready' : 'not ready'} · Network {wallet.chainId === 137 ? 'Polygon (137)' : wallet.chainId ? `${wallet.chainId}${permitToken ? ' — Polygon required' : ''}` : 'not ready'}</small>
      {switchingNetwork && <p>Waiting for Nimiq Pay to switch to Polygon. No signature requested.</p>}
      {switchRequested && (switchError || wallet.error) && <p>{switchError || wallet.error}</p>}
      {lastDiagnostic && <p className="signature-probe-step">Step: {PROBE_STEP_LABELS[lastDiagnostic.step]} — {lastDiagnostic.state}{lastDiagnostic.code !== undefined ? ` · RPC code ${lastDiagnostic.code}` : ''}</p>}
    </div>
    {permitToken && (wrongPermitNetwork || switchingNetwork) && wallet.provider && <button type="button" className="secondary" disabled={busy || switchingNetwork} onClick={() => void switchToPolygon()}>{switchingNetwork ? 'Switching wallet network…' : 'Switch wallet to Polygon'}</button>}
    <button type="button" className="secondary" aria-describedby={statusId} aria-busy={busy} disabled={busy || switchingNetwork || !!readiness} onClick={() => void run()}>{busy ? 'Waiting for wallet signature…' : permitToken ? `Test ${permitToken} expired zero Permit` : 'Test EIP-712 signature'}</button>
    {diagnostics.length > 0 && <details className="details"><summary>Non-sensitive diagnostic steps</summary><ol className="signature-probe-steps">{diagnostics.map((event, index) => <li key={index}>{PROBE_STEP_LABELS[event.step]} — {event.state}{event.code !== undefined ? ` · RPC code ${event.code}` : ''}</li>)}</ol><p className="fine-print">Local only. No addresses, payloads, signatures or provider error messages are recorded here. Share the step and numeric code, not your wallet data.</p></details>}
  </section>;
}
