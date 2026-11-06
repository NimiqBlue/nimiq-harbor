import { useEffect, useRef, useState } from 'react';
import { verifiedPersonalSignature } from './personal-signature';
import { authorizedAccount, type HarborProvider } from './wallet';

type Wallet = { provider: HarborProvider | null; account: `0x${string}` | null; selectionRevision: number };
let signing = false;
export function PersonalMessageSign({ wallet }: { wallet: Wallet }) {
  const [message, setMessage] = useState('');
  const [signature, setSignature] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const latest = useRef(wallet); latest.current = wallet;
  useEffect(() => {
    const provider = wallet.provider;
    const invalidate = () => { epoch.current++; setSignature(''); setStatus('Wallet changed. Review the message again.'); };
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider?.on?.(event, invalidate);
    return () => { epoch.current++; for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider?.removeListener?.(event, invalidate); };
  }, [wallet.provider, wallet.account, wallet.selectionRevision]);
  async function sign() {
    if (signing || busy || !message || !wallet.provider || !wallet.account) return;
    signing = true; setBusy(true); setSignature(''); setStatus('');
    const provider = wallet.provider, account = wallet.account, revision = wallet.selectionRevision, stamp = epoch.current;
    const current = () => epoch.current === stamp && latest.current.provider === provider && latest.current.account?.toLowerCase() === account.toLowerCase() && latest.current.selectionRevision === revision;
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      if (!current() || !authorizedAccount(accounts, account)) throw new Error('account');
      if (await provider.request({ method: 'eth_chainId' }) !== '0x89' || !current()) throw new Error('network');
      const bytes = new TextEncoder().encode(message);
      const hex = `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const result = await provider.request({ method: 'personal_sign', params: [hex, account] });
      if (!current()) return;
      const [accountsAfter, chainAfter, canonical] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' }), verifiedPersonalSignature(account, message, result)]);
      if (!current() || !authorizedAccount(accountsAfter, account) || chainAfter !== '0x89') throw new Error('signature verification');
      setSignature(canonical); setStatus('Verified for the selected account. Copy the hex signature below.');
    } catch {
      if (current()) setStatus('Could not sign the message. Check the selected account, Polygon mainnet and wallet. An invalid or mismatched signature is never shown. Try again only if you trust the message.');
    } finally { signing = false; setBusy(false); }
  }
  return <section className="personal-message-sign" aria-labelledby="personal-message-title">
    <h2 id="personal-message-title" tabIndex={-1}>Sign a message</h2>
    <p>Paste the exact message. Spaces and line breaks are preserved. Nothing is sent to Harbor.</p>
    <p className="sign-warning"><strong>Only sign messages you trust. A signature can authorize actions.</strong></p>
    <p className="sign-selected-account">Selected account<code>{wallet.account ?? 'Connect a wallet first.'}</code></p>
    <label htmlFor="personal-message">Message to sign</label>
    <textarea id="personal-message" rows={5} value={message} disabled={busy} onChange={event => { epoch.current++; setMessage(event.target.value); setSignature(''); setStatus(''); }} />
    <p>Review it in your wallet before confirming.</p>
    <button type="button" className="secondary full" disabled={busy || !message || !wallet.provider || !wallet.account} onClick={() => void sign()}>{busy ? 'Waiting for wallet…' : 'Sign message with selected wallet'}</button>
    {status && <p role="status">{status}</p>}
    {signature && <><label htmlFor="personal-signature">Signature · hex</label><textarea id="personal-signature" readOnly rows={4} value={signature} /><button type="button" className="secondary full" onClick={() => { void navigator.clipboard.writeText(signature).then(() => setStatus('Signature copied.'), () => setStatus('Copy failed. Select and copy the signature manually.')); }}>Copy signature</button></>}
  </section>;
}
