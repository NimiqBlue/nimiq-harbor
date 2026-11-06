import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { createPublicClient, encodeFunctionData, formatUnits, http, isAddress, parseUnits } from 'viem';
import { polygon } from 'viem/chains';
import { TOKENS } from '../swap/registry';
import { authorizedAccount, type HarborProvider } from './wallet';
import { canUseIndependentEstimate, independentEstimate } from './gas-fallback';
type Wallet = { provider: HarborProvider | null; account: `0x${string}` | null; selectionRevision: number };
type Token = 'USDT' | 'USDC' | 'WBTC' | 'POL';
const WBTC = '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6' as const;
const decimals = (t: Token) => t === 'POL' ? 18 : t === 'WBTC' ? 8 : 6;
const label = (t: Token) => t === 'USDT' ? 'USDT0' : t;
const contract = (t: Exclude<Token, 'POL'>) => t === 'WBTC' ? WBTC : TOKENS[t].address;
type Draft = { from: `0x${string}`; to: `0x${string}`; token: Token; amount: string; units: bigint; data: `0x${string}`; gas: `0x${string}`; fee: bigint; balance: bigint };
const balanceAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const abi = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }] as const;
let pending = false;
function quantity(v: unknown) { if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) throw Error('Read unavailable'); return BigInt(v); }
function rejected(e: unknown) { const v = e as {code?: unknown; data?: {originalError?: {code?: unknown}}} | null; return v?.code === 4001 || (v?.code === -32603 && v.data?.originalError?.code === 4001); }
export function ManualBankSend({ wallet, onOpen, restoreFocus }: { wallet: Wallet; onOpen: () => void; restoreFocus: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [to, setTo] = useState(''), [amount, setAmount] = useState(''), [token, setToken] = useState<Token>('USDT');
  const [opened, setOpened] = useState(false);
  const [visibleBalance, setVisibleBalance] = useState<string | null>(null);
  const [balanceRevision, setBalanceRevision] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [hash, setHash] = useState<string | null>(null);
  const balanceEpoch = useRef(0);
  const epoch = useRef(0), flight = useRef(false), latest = useRef(wallet); latest.current = wallet;
  const invalidate = () => { epoch.current++; setDraft(null); };
  useEffect(() => {
    const p = wallet.provider;
    setDraft(null);
    const changed = () => { epoch.current++; balanceEpoch.current++; setVisibleBalance(null); setBalanceRevision(value => value + 1); setDraft(null); setMessage('Wallet account or network changed. Review again.'); };
    for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) p?.on?.(name, changed);
    return () => { epoch.current++; for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) p?.removeListener?.(name, changed); };
  }, [wallet.provider, wallet.account, wallet.selectionRevision]);
  useEffect(() => {
    let active = true;
    const balanceStamp = ++balanceEpoch.current;
    setVisibleBalance(null);
    if (!opened || !wallet.account || !wallet.provider) return () => { active = false; };
    const client = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 15000, retryCount: 0 }) });
    (token === 'POL' ? client.getBalance({address: wallet.account}) : client.readContract({ address: contract(token), abi: balanceAbi, functionName: 'balanceOf', args: [wallet.account] }))
      .then(value => { if (active && balanceEpoch.current === balanceStamp) setVisibleBalance(formatUnits(value, decimals(token))); })
      .catch(() => { if (active && balanceEpoch.current === balanceStamp) setVisibleBalance('unavailable'); });
    return () => { active = false; };
  }, [opened, wallet.account, wallet.provider, wallet.selectionRevision, token, balanceRevision]);
  async function polBalance(from: `0x${string}`) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 15000, retryCount: 0 }) });
      return await client.getBalance({ address: from });
    } catch { throw Error('Could not read your POL balance on Polygon. Check your connection and review again. No transaction was requested.'); }
  }
  async function read(p: HarborProvider, method: string, params?: unknown[], compare = false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failures: Record<string, string> = {
      eth_accounts: 'Could not read authorized wallet accounts. Unlock your wallet and review again.',
      eth_chainId: 'Could not read the wallet network. Select Polygon mainnet and review again.',
      eth_getBalance: 'Could not read your POL balance. No transaction was requested.',
      eth_call: 'Could not read your token balance. No transaction was requested.',
      eth_estimateGas: 'Could not estimate this transfer. Check the token, recipient and wallet before reviewing again. No transaction was requested.',
      eth_gasPrice: 'Could not read the Polygon network fee. No transaction was requested.',
    };
    let timedOut = false;
    try { return await Promise.race([p.request(params ? {method, params} : {method}), new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Error('Read unavailable')); }, 15000); })]); }
    catch (error) {
      if (method === 'eth_estimateGas') {
        // Keep only allowlisted numeric codes; provider text and request data can contain PII.
        const allowed = new Set([4001, 4100, 4200, 4900, 4901, -32700, -32600, -32601, -32602, -32603, -32000, -32001, -32002, -32003, -32004, -32005]);
        const e = error as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null;
        const code = typeof e?.code === 'number' && allowed.has(e.code) ? e.code : null;
        const nested = typeof e?.data?.originalError?.code === 'number' && allowed.has(e.data.originalError.code) ? e.data.originalError.code : null;
        const entry = { time: new Date().toISOString(), method: 'eth_estimateGas', outcome: timedOut ? 'timeout' : 'provider-error', code, nestedCode: nested };
        try { sessionStorage.setItem('harbor.estimateGas.lastError.v1', JSON.stringify(entry)); } catch { /* storage may be unavailable */ }
        console.warn('[Harbor] gas estimation diagnostic', entry);
        // Independent estimation is automatic only for eligible wallet failures.
        const report = (comparison?: string) => {
          try { void fetch('/api/diagnostics/review-gas', {
            method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: entry.method, outcome: entry.outcome, code, nestedCode: nested, ...(comparison ? {comparison} : {}) }), keepalive: true,
          }).catch(() => {}); } catch { /* best effort */ }
        };
        if (compare && params && canUseIndependentEstimate(error, timedOut)) {
          try {
            const gas = await independentEstimate(params[0] as { from: `0x${string}`; to: `0x${string}`; data?: `0x${string}`; value?: `0x${string}` });
            report('success');
            return gas;
          } catch {
            report('unavailable');
            throw Error('Could not verify the independent Polygon estimate after the wallet estimate failed. No transaction was requested. Try reviewing again later.');
          }
        }
        report();
      }
      if (method === 'eth_gasPrice' && compare && canUseIndependentEstimate(error, timedOut)) {
        try {
          const client = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 15000, retryCount: 0 }) });
          const price = await client.getGasPrice();
          if (price <= 0n) throw Error('Invalid price');
          return `0x${price.toString(16)}`;
        } catch { throw Error('Could not read the network fee from the independent Polygon RPC. No transaction was requested. Try again later.'); }
      }
      throw Error(failures[method] ?? 'Could not verify the transfer. No transaction was requested.');
    }
    finally { clearTimeout(timer); }
  }
  async function preflight(p: HarborProvider, from: string, stamp: number, revision: number) {
    const accounts = await read(p, 'eth_accounts'), chain = await read(p, 'eth_chainId');
    if (epoch.current !== stamp || latest.current.provider !== p || latest.current.selectionRevision !== revision || latest.current.account?.toLowerCase() !== from.toLowerCase() || !authorizedAccount(accounts, from)) throw Error('Selected account changed or is not authorized. Review again.');
    if (chain !== '0x89') throw Error('Switch your wallet to Polygon mainnet before continuing.');
  }
  async function tokenBalance(d: Pick<Draft, 'from' | 'token' | 'units'>) {
    // Some injected wallets do not support eth_call. Read Polygon independently.
    if (d.token === 'POL') return;
    let tokens: bigint;
    try {
      const client = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 15000, retryCount: 0 }) });
      tokens = await client.readContract({ address: contract(d.token), abi: balanceAbi, functionName: 'balanceOf', args: [d.from] });
    } catch { throw Error('Could not read your token balance on Polygon. Check your connection and review again. No transaction was requested.'); }
    if (tokens < d.units) throw Error(`Insufficient ${label(d.token)} balance in the selected wallet. Available: ${formatUnits(tokens, decimals(d.token))}. Choose the funded account or lower the amount.`);
  }
  async function balances(d: Pick<Draft, 'from' | 'token' | 'units' | 'fee'>) {
    await tokenBalance(d);
    const balance = await polBalance(d.from);
    if (balance < d.fee + (d.token === 'POL' ? d.units : 0n)) throw Error(d.token === 'POL' ? 'Insufficient POL for the transfer amount plus the estimated network fee. Lower the amount or add POL and review again.' : 'Insufficient POL for the estimated network fee. Add POL and review again.');
    return balance;
  }
  async function useMax() {
    if (flight.current || pending) return;
    flight.current = true; pending = true; setBusy(true); setMessage(''); invalidate();
    const p = wallet.provider, from = wallet.account, stamp = epoch.current, revision = wallet.selectionRevision;
    try {
      if (!p || !from) throw Error('Connect and select a wallet account in the header first.');
      if (token !== 'POL' || !isAddress(to) || /^0x0{40}$/i.test(to)) throw Error('Enter a valid nonzero Polygon recipient address first.');
      await preflight(p, from, stamp, revision);
      const balance = await polBalance(from);
      if (balance <= 1n) throw Error('Insufficient POL for the transfer amount plus the estimated network fee.');
      const price = quantity(await read(p, 'eth_gasPrice', undefined, true));
      const estimate = quantity(await read(p, 'eth_estimateGas', [{from, to, value: '0x1'}], true));
      if (price <= 0n || estimate <= 0n) throw Error('Could not read the network fee.');
      const fee = ((estimate * 120n + 99n) / 100n) * price;
      if (balance <= fee) throw Error('Insufficient POL for the transfer amount plus the estimated network fee.');
      let units = balance - fee;
      // Contract recipients may consume different gas for different values. Only
      // publish a candidate that was itself estimated, reducing it when needed.
      let verified = false;
      for (let i = 0; i < 6; i++) {
        await preflight(p, from, stamp, revision);
        const actual = quantity(await read(p, 'eth_estimateGas', [{from, to, value: `0x${units.toString(16)}`}], true));
        if (actual <= 0n) throw Error('Could not read the network fee.');
        const actualFee = ((actual * 120n + 99n) / 100n) * price;
        if (balance <= actualFee) throw Error('Insufficient POL for the transfer amount plus the estimated network fee.');
        if (units + actualFee <= balance) { verified = true; break; }
        units = balance - actualFee;
      }
      if (!verified) throw Error('Could not calculate Max for this recipient. Review again.');
      await preflight(p, from, stamp, revision);
      setAmount(formatUnits(units, 18));
    } catch (error) {
      if (epoch.current === stamp) setMessage(error instanceof Error && /^(Enter|Connect|Selected|Switch|Insufficient|Could not|Network fee changed)/.test(error.message) ? error.message : 'Could not calculate Max. No transaction was requested.');
    } finally { flight.current = false; pending = false; setBusy(false); }
  }
  async function act(send: boolean) {
    if (flight.current || pending) return;
    flight.current = true; pending = true; setBusy(true); setMessage('');
    const p = wallet.provider, from = wallet.account, stamp = epoch.current, revision = wallet.selectionRevision;
    let attempted = false;
    try {
      if (!p || !from) throw Error('Connect and select a wallet account in the header first.');
      if (!send) {
        setDraft(null); setHash(null);
        if (!isAddress(to) || /^0x0{40}$/i.test(to)) throw Error('Enter a valid nonzero Polygon recipient address.');
        const precision = decimals(token);
        if (!(new RegExp(`^(?:0|[1-9][0-9]*)(?:[.,][0-9]{1,${precision}})?$`)).test(amount)) throw Error(`Enter a decimal amount with at most ${precision} decimal places.`);
        const canonicalAmount = amount.replace(',', '.');
        const units = parseUnits(canonicalAmount, precision);
        if (units <= 0n || units >= 2n ** 256n) throw Error('Enter an amount greater than zero within the token limit.');
        await preflight(p, from, stamp, revision);
        // Check tokens before estimation: ERC20 reverts otherwise hide insufficient funds.
        await tokenBalance({from, token, units});
        const pol = await polBalance(from);
        if (pol === 0n) throw Error('Insufficient POL for the network fee. Add POL and review again.');
        if (token === 'POL' && units >= pol) throw Error('Insufficient POL for the transfer amount plus the estimated network fee. Lower the amount or add POL and review again.');
        const data = token === 'POL' ? '0x' : encodeFunctionData({abi, functionName: 'transfer', args: [to, units]});
        const transaction = token === 'POL' ? {from, to, value: `0x${units.toString(16)}`} : {from, to: contract(token), data};
        const price = quantity(await read(p, 'eth_gasPrice', undefined, true));
        if (token === 'POL') {
          const probe = quantity(await read(p, 'eth_estimateGas', [{from, to, value: '0x1'}], true));
          if (probe <= 0n || price <= 0n) throw Error('Could not read the network fee.');
          if (pol < units + ((probe * 120n + 99n) / 100n) * price) throw Error('Insufficient POL for the transfer amount plus the estimated network fee. Lower the amount or add POL and review again.');
        }
        const estimate = quantity(await read(p, 'eth_estimateGas', [transaction], true));
        if (estimate <= 0n || price <= 0n) throw Error('Read unavailable');
        const gas = (estimate * 120n + 99n) / 100n, fee = gas * price;
        const balance = await balances({from, token, units, fee});
        await preflight(p, from, stamp, revision);
        setDraft({from, to, token, amount: canonicalAmount, units, data, gas: `0x${gas.toString(16)}`, fee, balance});
      } else {
        if (!draft) return;
        const d = draft;
        const execute = async () => {
          await preflight(p, d.from, stamp, revision);
          const transaction = d.token === 'POL' ? {from: d.from, to: d.to, value: `0x${d.units.toString(16)}`} : {from: d.from, to: contract(d.token), data: d.data};
          const price = quantity(await read(p, 'eth_gasPrice', undefined, true));
          const estimate = quantity(await read(p, 'eth_estimateGas', [transaction], true));
          if (price <= 0n || estimate <= 0n || ((estimate * 120n + 99n) / 100n) * price !== d.fee || `0x${((estimate * 120n + 99n) / 100n).toString(16)}` !== d.gas) throw Error('Network fee changed. Review the transfer again.');
          await balances(d);
          await preflight(p, d.from, stamp, revision);
          attempted = true; setDraft(null);
          // One physical RPC for this explicit click. No automatic retry or durable lock.
          const result = await p.request({method: 'eth_sendTransaction', params: [d.token === 'POL' ? {from: d.from, to: d.to, value: `0x${d.units.toString(16)}`, gas: d.gas} : {from: d.from, to: contract(d.token), data: d.data, gas: d.gas}]});
          if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) throw Error('Unknown wallet result');
          setHash(result); setMessage('Transaction submitted by the wallet. Check PolygonScan for confirmation; a hash does not prove completion.');
        };
        if (navigator.locks) await navigator.locks.request('harbor.manual-send.pending.v2', {ifAvailable: true}, async lock => { if (!lock) throw Error('Pending request'); await execute(); });
        else await execute();
      }
    } catch (error) {
      setDraft(null);
      if (attempted) setMessage(rejected(error) ? 'Wallet request rejected. Review again if you want to retry.' : 'The wallet request outcome is unknown. Check your wallet and PolygonScan before sending again: another transfer could duplicate the payment. Harbor will not retry automatically.');
      else if (epoch.current === stamp) setMessage(error instanceof Error && /^(Enter|Connect|Selected|Switch|Insufficient|Could not|Network fee changed)/.test(error.message) ? error.message : 'Could not verify the wallet, balances or network fee, or another request is pending. No transaction was sent by this action. Review again to retry.');
    } finally { flight.current = false; pending = false; setBusy(false); }
  }
  const close = () => { if (flight.current) return; invalidate(); setOpened(false); dialog.current?.close(); restoreFocus(); };
  return <div className="manual-send">
    <button ref={trigger} className="text-button" onClick={() => { setOpened(true); onOpen(); dialog.current?.showModal(); }}><span className="wallet-action-icon asset-placeholder" aria-hidden="true">→</span>Pay with wallet</button>
    {createPortal(<dialog ref={dialog} className="manual-send-dialog" aria-labelledby="manual-send-title" onCancel={e => {e.preventDefault(); close();}}>
      <div className="manual-send-heading"><span className="asset-placeholder" aria-hidden="true">Wallet</span><h2 id="manual-send-title">Send Polygon tokens</h2></div>
      <div className="manual-send-instructions"><p>Copy the recipient and exact amount from Mt Pelerin.</p><div className="manual-send-warning"><span className="manual-send-warning-title"><span className="asset-placeholder" aria-hidden="true">!</span>IMPORTANT<span className="asset-placeholder" aria-hidden="true">!</span></span><p className="manual-send-sender-warning"><strong>Use the same sending wallet address associated with your Mt Pelerin order.</strong><br />Check the address below against the one shown by Mt Pelerin.</p></div></div>
      <p className="manual-send-from">You are sending from:<br /><code>{wallet.account ?? 'Connect and select your wallet account in the header.'}</code></p>
      <label>Recipient address<input value={to} disabled={busy} onChange={e => {invalidate(); setTo(e.target.value);}} autoComplete="off" spellCheck={false} /></label>
      <fieldset className="manual-send-token-field"><legend>Token</legend><div className="manual-send-token-list">{([['USDT', 'USDT0'], ['USDC', 'USDC'], ['POL', 'POL'], ['WBTC', 'WBTC']] as const).map(([value, name]) => <button key={value} type="button" className="manual-send-token-option" disabled={busy} aria-pressed={token === value} onClick={() => {invalidate(); setToken(value);}}><span className="asset-placeholder" aria-hidden="true">{name.slice(0, 1)}</span><span>{name}</span></button>)}</div></fieldset>
      <p role="status">{label(token)} balance: {!wallet.account ? 'Connect a wallet' : visibleBalance ?? 'Loading…'}</p>
      <label>Exact amount<input value={amount} disabled={busy} onChange={e => {invalidate(); setAmount(e.target.value);}} inputMode="decimal" autoComplete="off" /></label>
      {token === 'POL' && <button type="button" className="text-button" disabled={busy || !wallet.account} onClick={() => void useMax()}>Max</button>}

      {draft && <div className="manual-send-review"><strong>Confirm irreversible transfer</strong><p>From: <code>{draft.from}</code></p><p>To: <code>{draft.to}</code></p><p>Amount: {draft.amount} {label(draft.token)}</p><p>Polygon mainnet · Chain 137</p>{draft.token === 'POL' ? <p>Asset: native POL (not WPOL)</p> : <p>Token contract: <code>{contract(draft.token)}</code></p>}<p>Estimated network fee: {formatUnits(draft.fee, 18)} POL (includes 20% gas-limit margin). Your wallet sets the final fee.</p><p>Estimated total: {draft.token === 'POL' ? `${formatUnits(draft.units + draft.fee, 18)} POL` : `${draft.amount} ${label(draft.token)} + ${formatUnits(draft.fee, 18)} POL`}</p><p>POL balance: {formatUnits(draft.balance, 18)}</p><button className="primary full" disabled={busy} onClick={() => void act(true)}>Confirm and open wallet</button></div>}
      {message && <p role="status">{message}</p>}
      {hash && <p><a className="manual-send-explorer" href={`https://polygonscan.com/tx/${hash}`} target="_blank" rel="noopener noreferrer">{`https://polygonscan.com/tx/${hash}`}</a></p>}
      {busy && <p role="status">Waiting for wallet… Do not send again while this request is pending.</p>}
      {!draft && <button className="primary full" disabled={busy || !wallet.account} onClick={() => void act(false)}>Review transfer</button>}
      <button className="secondary full" disabled={busy} onClick={close}>Close</button>
    </dialog>, document.body)}
  </div>;
}
