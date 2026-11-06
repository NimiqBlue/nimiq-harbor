import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSwapQuote } from './use-swap-quote';
import './swap-settings.css';
import { createPublicClient, http, formatUnits } from 'viem';
import { polygon } from 'viem/chains';

import { TOKENS } from '../swap/registry';
import { parseAmount } from '../shared/index';
import type { WalletController } from './wallet';

import { translations, type Language } from './i18n';
import { customSlippageBps } from './slippage';
import { MAX_AUTO_SLIPPAGE_BPS } from '../shared/auto-slippage';
import { displayAmount, percentageAmount, quoteRate } from './swap-display';
import { swapFees } from './swap-fees';
import { DEFAULT_SWAP_DEADLINE_MINUTES } from '../shared/swap-deadline';
import { fusionUnavailable, getFusionStatus, type FusionStatus } from './fusion';
import { claimSettlementRefresh } from './swap-receipt';
import type { VerifiedSwapReceipt } from './public-swap-recovery';
import { FusionExecution } from './FusionExecution';
import { PolBalance } from './PolBalance';
import { TokenPicker, tokenLabels as labels, type TokenSymbol as Symbol } from './TokenPicker';
type AvailableSymbol = Exclude<Symbol, 'NIM'>;
const issuerNames: Record<AvailableSymbol, string> = { USDC: 'Circle', USDT: 'Tether · USDT0' };
function TokenContractSource({ symbol }: { symbol: AvailableSymbol }) {
  return <span className="token-contract-label">Official Polygon token contract. Verify here <a className="token-source" href={TOKENS[symbol].source} target="_blank" rel="noopener noreferrer" aria-label={`Verify ${symbol} Polygon contract on ${issuerNames[symbol]} documentation (opens in a new tab)`}>{issuerNames[symbol]} ↗</a></span>;
}
export function SwapPanel({ wallet, language }: { wallet: WalletController; language: Language }) {
  const t = translations[language]; const [amount, setAmount] = useState('');
  const [from, setFrom] = useState<Symbol>('USDT'); const [to, setTo] = useState<Symbol>('USDC');

  const nimSelected = from === 'NIM' || to === 'NIM';
  const fromToken = from === 'NIM' ? null : TOKENS[from];
  const toToken = to === 'NIM' ? null : TOKENS[to];
  const [slippageMode, setSlippageMode] = useState<'auto' | 'custom'>('auto');
  const [customSlippage, setCustomSlippage] = useState('0.5');
  const [settingsRevision, setSettingsRevision] = useState(0);

  const requestedSlippage = slippageMode === 'auto' ? MAX_AUTO_SLIPPAGE_BPS : customSlippageBps(customSlippage);

  const [now, setNow] = useState(Date.now());
  const [amountFocused, setAmountFocused] = useState(false);
  // Keep the exact reviewed Auto bps independent of transient quote eligibility.
  // Visibility refresh clears wallet chain evidence (and therefore the preview),
  // but is not an edit to the user's consent. Real edits/events still invalidate
  // FusionExecution through intent/settings/selection and its wallet event latch.
  const [reviewState, setReviewState] = useState<{ active: boolean; slippage: number | null }>({ active: false, slippage: null });
  const reviewActive = reviewState.active;
  const [fusionStatus, setFusionStatus] = useState<FusionStatus | null>(null);
  const [fusionMessage, setFusionMessage] = useState('Checking gasless quote availability…');

  useEffect(() => {
    let active = true;
    void getFusionStatus().then(status => {
      if (!active) return;
      setFusionStatus(status);
      setFusionMessage(status.available && status.configured
        ? status.executionEnabled ? 'No network gas to pay. Review before signing.' : 'Quote preview only. Swaps are currently unavailable.'
        : 'Swaps are currently unavailable. Please try again later.');
    }).catch(error => { if (active) setFusionMessage(fusionUnavailable(error)); });
    return () => { active = false; };
  }, []);

  const [balances, setBalances] = useState<Partial<Record<Symbol | 'POL', string>>>({});
  const [balanceError, setBalanceError] = useState('');
  const [balanceRefresh, setBalanceRefresh] = useState(0);
  const onSettlement = useCallback((receipt: VerifiedSwapReceipt) => {
    if(wallet.account?.toLowerCase()===receipt.account && claimSettlementRefresh(receipt))setBalanceRefresh(n=>n+1);
  }, [wallet.account]);
  useEffect(() => {
    let active = true; setBalances({}); setBalanceError('');
    if (!wallet.account) return;
    const account = wallet.account;
    void (async () => {
      try {

        const client = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 15000, retryCount: 0 }) });
        const blockNumber = await client.getBlockNumber();
        const values = await Promise.all(([from, to] as const).map(async symbol => {
          if (symbol === 'NIM') return null;
          const token = TOKENS[symbol];
          const balance = await client.readContract({ address: token.address, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [account], blockNumber });
          return [symbol, formatUnits(balance, token.decimals)] as const;
        }));
        const pol = await client.getBalance({ address: account, blockNumber });
        if (active) setBalances({ ...Object.fromEntries(values.filter((value): value is NonNullable<typeof value> => value !== null)), POL: formatUnits(pol, 18) });
      } catch { if (active) setBalanceError('Polygon balances unavailable. Reconnect or check the RPC connection.'); }
    })();
    return () => { active = false; };
  }, [wallet.account, wallet.revision, from, to, balanceRefresh]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const quoteRequest = useMemo(() => {
    try {
      if (!fromToken || !toToken || requestedSlippage === null || !fusionStatus?.available || !fusionStatus.configured || !wallet.account || wallet.chainId !== 137) return null;
      return { chainId: 137 as const, account: wallet.account, tokenIn: fromToken!.address, tokenOut: toToken!.address, amount: parseAmount(amount, (fromToken?.decimals ?? 0)).toString(), slippageBps: requestedSlippage, ...(slippageMode === 'auto' ? {autoSlippage:true} : {}) };
    } catch { return null; }
  }, [amount, from, to, requestedSlippage, slippageMode, fusionStatus, wallet.account, wallet.chainId, wallet.revision]);
  const { quote: rawQuote, busy, error, refresh: requestQuote } = useSwapQuote(quoteRequest, reviewActive, wallet.selectionRevision);
  const fusionQuote = nimSelected ? null : rawQuote;
  const expired = Boolean(fusionQuote && fusionQuote.expiresAt <= now);
  const slippage = slippageMode === 'auto' ? (fusionQuote?.autoSlippage ? fusionQuote.request.slippageBps : null) : requestedSlippage;

  const executionSlippage = reviewActive ? reviewState.slippage : slippage;
  let executionIntent = null;
  try { if (!nimSelected && executionSlippage !== null && amount) executionIntent = { chainId: 137 as const, tokenIn: fromToken!.address, tokenOut: toToken!.address, amount: parseAmount(amount, (fromToken?.decimals ?? 0)).toString(), slippageBps: executionSlippage }; } catch { /* Incomplete input cannot prepare an order. */ }
  const executionFloor = fusionQuote && !expired && !busy && slippage !== null && fusionQuote.quote.minimumReceiveAmount !== undefined ? BigInt(fusionQuote.quote.minimumReceiveAmount) : null;
  let insufficientBalance = false;
  try { insufficientBalance = Boolean(executionIntent && balances[from] !== undefined && BigInt(executionIntent.amount) > (balances[from] === '0' ? 0n : parseAmount(balances[from]!, (fromToken?.decimals ?? 0)))); } catch { /* Unknown balance must not be presented as zero. */ }
  const balanceHint = insufficientBalance ? `Not enough ${from === 'USDT' ? 'USDT0' : from} in this account. Enter a smaller amount, add tokens on Polygon, or change account in the wallet menu.` : '';
  const rate = fusionQuote && !expired ? quoteRate(fusionQuote.request.amount, (fromToken?.decimals ?? 0), fusionQuote.quote.expectedAmount, (toToken?.decimals ?? 0)) : null;
  const fees = swapFees(fusionQuote && !expired && !busy ? fusionQuote.quote : null, (toToken?.decimals ?? 0), to === 'USDT' ? 'USDT0' : to);
  return <section className="card swap-card" aria-labelledby="swap-title">
    <div className="card-top swap-heading"><h2 id="swap-title" lang="en">Swap tokens</h2>{!nimSelected && <span className="gas-included" title={from === 'USDT' ? 'USDT0 requires an exact on-chain approval paid in POL. Fusion settlement remains resolver-paid.' : 'The resolver pays execution gas; costs may be reflected in your quote.'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M3 21h12M4 11h10M17 5l3 3v9a2 2 0 0 1-4 0v-3a1 1 0 0 0-1-1h-1M18 6v4h2"/></svg>{from === 'USDT' ? 'Approval requires POL' : fusionStatus?.executionEnabled ? 'Gas included' : 'Gasless'}</span>}</div>
    <PolBalance key={`${wallet.account ?? 'disconnected'}:${wallet.revision}:${balanceRefresh}`} account={wallet.account} revision={wallet.revision} />
    {fusionStatus?.executionEnabled !== true && <p id="amount-help" className="mode-note" role="status">{fusionMessage}</p>}
    <div className="token-box"><div className="token-meta"><label htmlFor="pay-amount">Sell</label><span>Balance: {balances[from] === undefined ? '—' : displayAmount(balances[from]!)}</span></div><div className="token-input"><input id="pay-amount" aria-label={t.pay} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amountFocused ? amount : displayAmount(amount)} title={`Exact sell amount: ${amount || '0'}. Focus to edit full precision.`} onFocus={() => setAmountFocused(true)} onBlur={() => setAmountFocused(false)} onChange={e => setAmount(e.target.value)} aria-describedby={fusionStatus?.executionEnabled !== true ? 'amount-help' : undefined} /><TokenPicker label="Pay token" value={from} options={Object.keys(labels) as Symbol[]} onChange={next => { setFrom(next); if (next === to) setTo(from); }} /></div><span className="token-name">{labels[from]}</span>{from === 'NIM' ? <span className="swap-token-details">Available soon</span> : <details className="swap-token-details"><summary>Token details</summary><TokenContractSource symbol={from} /><code className="token-contract" aria-label="Pay token contract">{fromToken!.address}</code></details>}</div>
    <div className="balance-percentages" role="group" aria-label="Sell balance percentage">{([25, 50, 75, 100] as const).map(percent => <button key={percent} disabled={percentageAmount(balances[from], (fromToken?.decimals ?? 0), percent) === null} onClick={() => { const next = percentageAmount(balances[from], (fromToken?.decimals ?? 0), percent); if (next !== null) setAmount(next); }}>{percent === 100 ? 'MAX' : `${percent}%`}</button>)}</div>
    <div className="direction-row"><button className="direction-button" aria-label="Reverse swap direction" onClick={() => { setFrom(to); setTo(from); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6" /></svg></button></div>
    <div className="token-box receive-box"><div className="token-meta"><span aria-label={t.receive}>Buy</span><span>Balance: {balances[to] === undefined ? '—' : displayAmount(balances[to]!)}</span></div><div className="token-input"><output className={!fusionQuote ? 'placeholder' : ''} title={fusionQuote ? `Exact indicative buy amount: ${formatUnits(BigInt(fusionQuote.quote.expectedAmount), (toToken?.decimals ?? 0))}` : undefined}>{fusionQuote ? `≈ ${displayAmount(formatUnits(BigInt(fusionQuote.quote.expectedAmount), (toToken?.decimals ?? 0)))}` : '—'}</output><TokenPicker label="Receive token" value={to} options={(Object.keys(labels) as Symbol[]).filter(symbol => symbol !== from)} onChange={setTo} /></div><span className="token-name">{labels[to]}</span>{to === 'NIM' ? <span className="swap-token-details">Available soon</span> : <details className="swap-token-details"><summary>Token details</summary><TokenContractSource symbol={to} /><code className="token-contract" aria-label="Receive token contract">{toToken!.address}</code></details>}</div>

    {Number(slippage) > 100 && <div className={`alert slippage-warning ${Number(slippage) >= 500 ? 'danger' : ''}`} role={Number(slippage) >= 500 ? 'alert' : 'status'}><strong>{Number(slippage) >= 500 ? 'Very high slippage' : 'High slippage'}: {Number(slippage) / 100}%</strong><p>Accepts up to {Number(slippage) / 100}% less output; greater loss risk. No fill guarantee.</p></div>}
    {balanceError && <div className="alert" role="status">{balanceError}</div>}
    {error && <div className="swap-quote-feedback" role="alert"><strong>Quote unavailable</strong><p>{error}</p><button className="text-button" disabled={busy || reviewActive} onClick={() => void requestQuote()}>Refresh quote</button></div>}
    {expired && !error && <div className="alert" role="status">Previous quote · display only. Review needs a fresh quote. <button className="text-button" disabled={busy || reviewActive} onClick={() => void requestQuote()}>Refresh quote</button></div>}
    {balanceHint && <p id="swap-balance-hint" className="alert swap-balance-hint" role="status">{balanceHint}</p>}
    <dl className="quote-essentials"><div><dt>Minimum received</dt><dd title={executionFloor !== null ? `Exact indicative net minimum after included provider costs: ${formatUnits(executionFloor, (toToken?.decimals ?? 0))}` : undefined}>{executionFloor !== null ? `${displayAmount(formatUnits(executionFloor, (toToken?.decimals ?? 0)))} ${to === 'USDT' ? 'USDT0' : to} · net, indicative` : 'Shown with quote'}</dd></div><div><dt>Fees</dt><dd title={fees.title}>{fees.text}</dd></div></dl>
    {busy && <p className="action-note" role="status">Updating quote…</p>}
    <FusionExecution onSettlement={onSettlement} wallet={wallet} enabled={!nimSelected && fusionStatus?.executionEnabled === true} intent={executionIntent} previewFloor={executionFloor} previewId={fusionQuote?.id} previewValidUntil={fusionQuote?.expiresAt} onActivityChange={active => setReviewState(previous => previous.active === active ? previous : { active, slippage: active ? slippage : null })} reviewBlockedReason={balanceHint} deadlineMinutes={DEFAULT_SWAP_DEADLINE_MINUTES} settingsRevision={settingsRevision} />
    <div id="swap-slippage" className="slippage-control swap-settings-inline" role="region" aria-label="Swap settings">
      <div className="swap-settings-title"><span className="slippage-value">{slippageMode === 'auto' ? slippage === null || expired ? 'AUTO · awaiting quote' : `AUTO · ${slippage / 100}%` : slippage === null ? 'Set maximum' : `${slippage / 100}%`}</span></div>
      <div className="slippage-panel">
        <div className="slippage-heading">Maximum slippage</div>
        <div className="slippage-presets" role="group" aria-label="Slippage mode"><button aria-pressed={slippageMode === 'auto'} onClick={() => { setSettingsRevision(v => v + 1); setSlippageMode('auto'); }}>Auto</button>{['0.1', '0.5', '1'].map(value => <button key={value} aria-pressed={slippageMode === 'custom' && customSlippage === value} onClick={() => { setSettingsRevision(v => v + 1); setSlippageMode('custom'); setCustomSlippage(value); }}>{value}%</button>)}</div>
        <div className="custom-slippage"><label htmlFor="custom-slippage">Custom maximum</label><input id="custom-slippage" inputMode="decimal" autoComplete="off" placeholder="0.5" value={slippageMode === 'custom' ? customSlippage : ''} aria-invalid={slippageMode === 'custom' && slippage === null} aria-describedby="slippage-help" onChange={event => { setSettingsRevision(v => v + 1); setSlippageMode('custom'); setCustomSlippage(event.target.value); }} /><span>%</span></div>
        <p id="slippage-help" className="slippage-help">{slippageMode === 'auto' ? 'From the 1inch estimate for this trade · up to 1%.' : slippage === null ? 'Enter 0.01–20%, with up to two decimal places.' : 'Your maximum sets the review minimum. A tighter limit can prevent a fill; a wider limit accepts less output.'}</p>
        {from === 'USDT' ? <p className="slippage-help" role="status">USDT0 approval does not expire; resetting unused allowance requires POL.</p> : <p className="slippage-help" role="status">A signed token permit stays valid until expiry, even if you cancel the swap.</p>}
      </div>
    </div>
    {rate && <details className="exchange-rate"><summary>1 {from === 'USDT' ? 'USDT0' : from} ≈ {rate.display} {to === 'USDT' ? 'USDT0' : to}</summary><p>From this indicative quote: {rate.amounts}. Exact rate: {rate.exact} {to === 'USDT' ? 'USDT0' : to} per {from === 'USDT' ? 'USDT0' : from}. Execution may differ.</p></details>}
    {!fusionStatus?.executionEnabled && <p className="read-only-notice">Mainnet approvals and swaps are disabled. Nothing will be sent.</p>}
  </section>;
}
