import { useCallback, useEffect, useRef, useState } from 'react';

export interface HarborProvider {
  /** Discovery hint only; never an authorization or security check. */
  isMetaMask?: boolean;
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface DiscoveredWallet { id: string; name: string; provider: HarborProvider; rdns?: string | undefined }
const SELECTION_KEY = 'harbor.wallet-selection.v1';
interface RememberedSelection { provider: string; account: `0x${string}` }
function readSelection(): RememberedSelection | null {
  try {
    const raw = sessionStorage.getItem(SELECTION_KEY);
    if (!raw || raw.length > 1024) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const entry = value as Partial<RememberedSelection>;
    return typeof entry.provider === 'string' && /^(rdns:[a-z0-9.-]{3,200}|legacy:metamask)$/.test(entry.provider)
      && typeof entry.account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(entry.account)
      ? { provider: entry.provider, account: entry.account } : null;
  } catch { return null; }
}
function forgetSelection() { try { sessionStorage.removeItem(SELECTION_KEY); } catch { /* Storage is optional, never authorization. */ } }
function providerKeys(wallet: DiscoveredWallet): string[] {
  // Discovery identity is a routing hint, not authorization. Never persist a
  // discovery index/UUID/name: these may change on the next document load.
  const keys = wallet.rdns ? [`rdns:${wallet.rdns}`] : [];
  if (wallet.provider === (window as Window & { ethereum?: HarborProvider }).ethereum && wallet.provider.isMetaMask === true) keys.push('legacy:metamask');
  return keys;
}
export interface WalletSnapshot { account: `0x${string}` | null; chainId: number | null; revision: number }
export function isProvider(value: unknown): value is HarborProvider {
  return !!value && typeof (value as HarborProvider).request === 'function';
}
export function discoverProviders(target: Window, onChange: (wallets: DiscoveredWallet[]) => void) {
  const wallets: DiscoveredWallet[] = [];
  const add = (wallet: DiscoveredWallet, announced = false) => {
    if (!isProvider(wallet.provider)) return;
    const existing = wallets.find(w => w.provider === wallet.provider);
    if (existing) {
      // EIP-6963 supplies the actual wallet name for a legacy injected entry.
      if (announced && (existing.name !== wallet.name || existing.rdns !== wallet.rdns)) { existing.name = wallet.name; existing.rdns = wallet.rdns; onChange([...wallets]); }
      return;
    }
    wallets.push({ ...wallet, id: `wallet-${wallets.length}` }); onChange([...wallets]);
  };
  const injected = (target as Window & { ethereum?: HarborProvider }).ethereum;
  if (isProvider(injected)) add({ id: 'injected', name: 'Injected wallet', provider: injected });
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { uuid?: string; name?: string; rdns?: string }; provider?: HarborProvider }>).detail;
    const rdns = typeof detail?.info?.rdns === 'string' && /^[a-z0-9.-]{3,200}$/.test(detail.info.rdns) ? detail.info.rdns : undefined;
    if (detail?.provider) add({ id: detail.info?.uuid ?? 'announced', name: typeof detail.info?.name === 'string' && detail.info.name.trim() ? detail.info.name.trim().slice(0, 80) : 'Browser wallet', rdns, provider: detail.provider }, true);
  };
  const lateInjection = () => { const provider = (target as Window & { ethereum?: HarborProvider }).ethereum; if (isProvider(provider)) add({ id: 'injected', name: 'Injected wallet', provider }); };
  target.addEventListener('eip6963:announceProvider', announce);
  target.addEventListener('ethereum#initialized', lateInjection);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  let probes = 0;
  const readinessTimer = setInterval(() => { lateInjection(); if (++probes >= 10) clearInterval(readinessTimer); }, 500);
  return () => { clearInterval(readinessTimer); target.removeEventListener('eip6963:announceProvider', announce); target.removeEventListener('ethereum#initialized', lateInjection); };
}
export function walletError(error: unknown): string {
  if ((error as { code?: number })?.code === 4001) return 'Request declined. Nothing was signed or sent. You can try again.';
  return error instanceof Error ? error.message : 'The wallet could not complete this request. Please reconnect and try again.';
}
/** EIP-1193 errors can be plain objects; wrappers may retain an RPC code. */
export function walletRpcCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: unknown; rpcCode?: unknown; data?: { originalError?: unknown } };
  const code = typeof value.code === 'number' && Number.isSafeInteger(value.code) ? value.code : null;
  const wrapped = typeof value.rpcCode === 'number' && Number.isSafeInteger(value.rpcCode) ? value.rpcCode : null;
  if (wrapped !== null) return wrapped;
  if (code === -32603 && value.data?.originalError && value.data.originalError !== error) {
    const original = value.data.originalError as { code?: unknown };
    if (typeof original.code === 'number' && Number.isSafeInteger(original.code)) return original.code;
  }
  return code;
}
export function parseAccounts(value: unknown): `0x${string}`[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is `0x${string}` => {
    if (typeof item !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(item) || seen.has(item.toLowerCase())) return false;
    seen.add(item.toLowerCase()); return true;
  });
}
/** No implicit first-account choice when more than one account is authorized. */
export function parseAccount(value: unknown): `0x${string}` | null {
  const accounts = parseAccounts(value); return accounts.length === 1 ? accounts[0]! : null;
}
export function authorizedAccount(value: unknown, selected: string): `0x${string}` | null {
  return parseAccounts(value).find(account => account.toLowerCase() === selected.toLowerCase()) ?? null;
}
export function useWallet(initialPage: 'swap' | 'bank' | 'external' = 'swap') {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [provider, setProvider] = useState<HarborProvider | null>(null);
  const [state, setState] = useState<WalletSnapshot>({ account: null, chainId: null, revision: 0 });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Only fresh default authorization suppresses the otherwise-required chooser.
  // Restore/removal failures and explicit account changes keep their safeguards.
  const [connectingDefault, setConnectingDefault] = useState(false);
  const [accounts, setAccounts] = useState<`0x${string}`[]>([]);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [accountChoiceOpen, setAccountChoiceOpen] = useState(false);
  const selectedAccount = useRef<`0x${string}` | null>(null);
  const [storedSelection] = useState(readSelection);
  const remembered = useRef(storedSelection);
  const restoring = useRef<{ provider: HarborProvider; account: `0x${string}` } | null>(null);
  const readOnlyRestored = useRef(new WeakSet<HarborProvider>());
  const mustChoose = useRef(false);
  const activeProvider = useRef<HarborProvider | null>(null);
  const clearSelection = useCallback((required = false) => {
    remembered.current = null; restoring.current = null; forgetSelection();
    setAccountChoiceOpen(false);
    selectedAccount.current = null; mustChoose.current = required;
    setSelectionRevision(n => n + 1);
  }, []);
  const epoch = useRef(0);
  // Snapshot refreshes can supersede each other, but normal chainChanged events
  // during a switch must not cancel that operation. Disconnects must cancel both.
  const operation = useRef(0);
  const page = useRef<'swap' | 'bank' | 'external'>(initialPage);
  // A wallet prompt cannot be cancelled. Keep its physical RPC serialized even
  // after a tab/disconnect invalidates the logical continuation.
  const flight = useRef<number | null>(null);
  const defaultFlight = useRef<number | null>(null);

  const setPage = (next: 'swap' | 'bank' | 'external') => {
    if (page.current === next) return;
    if (defaultFlight.current !== null) cancelConnection();
    page.current = next; operation.current++;
    if (flight.current === null) setBusy(false);
  };
  const settle = (current: number) => {
    if (flight.current === current) { flight.current = null; defaultFlight.current = null; setBusy(false); setConnectingDefault(false); }
  };
  // Refreshing network/authorization evidence is not an account change. Keep
  // the provider-scoped explicit choice visible while reads are held or fail;
  // real removal/disconnect/change paths clearSelection() before invalidating.
  const invalidate = useCallback(() => { epoch.current++; setState(s => ({ account: selectedAccount.current, chainId: null, revision: s.revision + 1 })); }, []);
  // Local cancellation cannot close a wallet-owned prompt. Invalidate every
  // continuation now, but retain the physical latch until that RPC settles.
  const endConnection = () => {
    operation.current++; defaultFlight.current = null;
    activeProvider.current = null; clearSelection(); setAccounts([]);
    invalidate(); setProvider(null); setConnectingDefault(false);
    setBusy(flight.current !== null);
  };
  const cancelConnection = () => {
    endConnection(); setError(''); setNotice('Connection cancelled');
  };
  useEffect(() => discoverProviders(window, setWallets), []);
  const refresh = useCallback(async (p: HarborProvider, accountChoicesOnly = false) => {
    const current = ++epoch.current;
    const [accountResult, chainResult] = await Promise.allSettled([p.request({ method: 'eth_accounts' }), accountChoicesOnly ? Promise.resolve(null) : p.request({ method: 'eth_chainId' })]);
    if (current !== epoch.current || activeProvider.current !== p) return;
    // Authorization is independent of network connectivity. Do not discard a
    // successful fresh account list just because eth_chainId rejects (4901,
    // disconnected RPC, etc.), nor misreport it as a rejected permission RPC.
    if (accountResult.status === 'rejected') {
      setState(s => ({ account: selectedAccount.current, chainId: null, revision: s.revision + 1 }));
      throw accountResult.reason;
    }
    const chain = chainResult.status === 'fulfilled' ? chainResult.value : null;
    const chainId = typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain) ? Number.parseInt(chain, 16) : null;
    const available = parseAccounts(accountResult.value);
    const candidate = restoring.current;
    if (chainId === null && candidate?.provider === p) throw new Error('Wallet network could not be read. Select a network in your wallet, then reconnect.');
    if (candidate?.provider === p) {
      restoring.current = null;
      // The stored address never becomes a public snapshot (or balance key)
      // until a fresh, read-only membership check succeeds for this provider.
      const restored = authorizedAccount(available, candidate.account);
      if (restored) { selectedAccount.current = restored; setSelectionRevision(n => n + 1); }
      else clearSelection(true);
    }
    if (selectedAccount.current && !authorizedAccount(available, selectedAccount.current)) clearSelection(true);
    if (available.length > 1) mustChoose.current = true;
    if (!selectedAccount.current && !mustChoose.current) selectedAccount.current = parseAccount(available);
    setAccounts(available);
    setState(s => ({ account: selectedAccount.current, chainId: accountChoicesOnly ? s.chainId : chainId, revision: s.revision + 1 }));
    if (!accountChoicesOnly && chainId === null) throw new Error('Wallet network could not be read. Account access is separate; select a network in your wallet or retry the network connection.');
  }, [clearSelection]);
  useEffect(() => {
    const entry = remembered.current;
    if (!entry || activeProvider.current) return;
    const matches = wallets.filter(wallet => providerKeys(wallet).includes(entry.provider));
    if (matches.length !== 1) return;
    const p = matches[0]!.provider;
    remembered.current = null;
    restoring.current = { provider: p, account: entry.account };
    mustChoose.current = true;
    readOnlyRestored.current.add(p);
    activeProvider.current = p; setProvider(p);
    void refresh(p).catch(e => {
      if (activeProvider.current !== p) return;
      clearSelection(true); invalidate(); setError(walletError(e));
    });
  }, [wallets, refresh, clearSelection, invalidate]);
  useEffect(() => {
    if (!provider) return;
    const changed = () => { if (activeProvider.current !== provider) return; invalidate(); void refresh(provider).catch(e => { if (activeProvider.current === provider) setError(walletError(e)); }); };
    const accountsChanged = (value: unknown) => {
      if (activeProvider.current !== provider) return;
      const available = parseAccounts(value);
      if (available.length > 1) mustChoose.current = true;
      const selected = selectedAccount.current ?? restoring.current?.account;
      if (selected && !authorizedAccount(available, selected)) { operation.current++; clearSelection(true); }
      setAccounts(available); changed();
    };
    const disconnected = () => { if (activeProvider.current !== provider) return; operation.current++; activeProvider.current = null; clearSelection(); setAccounts([]); invalidate(); setProvider(null); setBusy(false); setError('Wallet disconnected. Reconnect to continue.'); };
    const visibility = () => { if (activeProvider.current !== provider) return; invalidate(); if (document.visibilityState === 'visible') void refresh(provider).catch(e => { if (activeProvider.current === provider) setError(walletError(e)); }); };
    provider.on?.('accountsChanged', accountsChanged); provider.on?.('chainChanged', changed); provider.on?.('disconnect', disconnected);
    document.addEventListener('visibilitychange', visibility);
    return () => { provider.removeListener?.('accountsChanged', accountsChanged); provider.removeListener?.('chainChanged', changed); provider.removeListener?.('disconnect', disconnected); document.removeEventListener('visibilitychange', visibility); };
  }, [provider, refresh, invalidate, clearSelection]);
  const connect = async (selected?: HarborProvider, _requirePolygon = true) => {
    if (flight.current !== null) return;
    setError(''); setNotice(''); const p = selected ?? provider ?? wallets[0]?.provider;
    if (!p) { setError('No Ethereum wallet detected. Open Harbor inside Nimiq Pay, or enable an EIP-1193 browser wallet, then try again.'); return; }
    const current = ++operation.current;
    // Fresh Connect accepts the wallet's default (first authorized address).
    // Existing selections and all background/removal guards remain independent.
    if (activeProvider.current !== p) { clearSelection(true); setAccounts([]); }
    else if (restoring.current) clearSelection(true);
    readOnlyRestored.current.delete(p);
    const fresh = !selectedAccount.current;
    let completed = false;
    setConnectingDefault(fresh);
    defaultFlight.current = fresh ? current : null;
    flight.current = current;
    activeProvider.current = p;
    setBusy(true); setProvider(p); invalidate();
    try {
      // Account access and network selection are separate wallet permissions.
      // Read the chain AFTER authentication, never from a pre-login snapshot.
      const accounts = await p.request({ method: 'eth_requestAccounts' });
      if (current !== operation.current || activeProvider.current !== p) return;
      // Wallets commonly emit accountsChanged while authorizing. That initial
      // event is not cancellation; take the membership epoch after the reply.
      const authorizationEpoch = epoch.current;
      const authorized = parseAccounts(accounts);
      if (!authorized.length) throw new Error('Wallet did not share a valid Ethereum account. Unlock the wallet and try connecting again.');
      if (!selectedAccount.current) {
        // Revalidate the returned default; never substitute another address if
        // authorization changed while Connect was pending.
        const available = await p.request({ method: 'eth_accounts' });
        if (current !== operation.current || activeProvider.current !== p || authorizationEpoch !== epoch.current) return;
        const selected = authorizedAccount(available, authorized[0]!);
        if (!selected) throw new Error('The wallet default account is no longer authorized. Reconnect or choose an available account.');
        selectedAccount.current = selected; setSelectionRevision(n => n + 1);
        const wallet = wallets.find(wallet => wallet.provider === p);
        const key = wallet && providerKeys(wallet).find(key => wallets.filter(wallet => providerKeys(wallet).includes(key)).length === 1);
        if (key) {
          try { sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ provider: key, account: selected })); } catch { /* Selection works without persistence. */ }
        }
      }
      await ensurePolygon(p, selectedAccount.current, current);
      if (current !== operation.current || activeProvider.current !== p) return;
      await refresh(p);
      if (current !== operation.current || activeProvider.current !== p) return;
      completed = true;
    } catch (e) {
      if (current !== operation.current) return;
      if (fresh || walletRpcCode(e) === 4001) {
        endConnection();
        if (walletRpcCode(e) === 4001) setNotice('Connection cancelled');
        else setError(walletError(e));
        return;
      }
      // Existing account changes are separate from a fresh connection.
      try { await refresh(p); } catch { /* Preserve the original actionable error. */ }
      if (current === operation.current) setError(walletError(e));
    } finally {
      if (fresh && !completed && current === operation.current && activeProvider.current === p) cancelConnection();
      if (activeProvider.current === p && current !== operation.current) {
        try { await refresh(p); } catch { /* Cancelled connection: no stale errors. */ }
      }
      settle(current);
    }
  };
  // Caller holds the physical prompt latch and an operation generation.
  const ensurePolygon = async (p: HarborProvider, account: string, current: number) => {
    const available = await p.request({ method: 'eth_accounts' });
    if (current !== operation.current || activeProvider.current !== p || selectedAccount.current !== account) return;
    if (!authorizedAccount(available, account)) throw new Error('Selected account is no longer authorized. Choose an account again.');
    let chain = await p.request({ method: 'eth_chainId' });
    if (current !== operation.current || activeProvider.current !== p || selectedAccount.current !== account) return;
    if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain)) throw new Error('Wallet did not report a valid chain. Select Polygon in your wallet.');
    if (Number.parseInt(chain, 16) !== 137) {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
      if (current !== operation.current || activeProvider.current !== p || selectedAccount.current !== account) return;
      chain = await p.request({ method: 'eth_chainId' });
      if (current !== operation.current) return;
      if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || Number.parseInt(chain, 16) !== 137) throw new Error('Polygon was not selected by the wallet. Use Switch wallet to Polygon to retry.');
    }
  };
  const switchPolygon = async () => {
    if (flight.current !== null || !provider || !selectedAccount.current) return;
    const p = provider; const account = selectedAccount.current;
    const current = ++operation.current;
    flight.current = current; setBusy(true); setError(''); setNotice(''); invalidate();
    try { await ensurePolygon(p, account, current); }
    catch (e) { if (current === operation.current) { if (walletRpcCode(e) === 4001) cancelConnection(); else setError(walletError(e)); } }
    finally {
      if (activeProvider.current === p) {
        try { await refresh(p); } catch (e) { if (current === operation.current) setError(walletError(e)); }
      }
      settle(current);
    }
  };

  const chooseAccount = async (account: string) => {
    const p = activeProvider.current;
    if (!p || busy || flight.current !== null) return;
    const current = ++operation.current;
    flight.current = current;
    setBusy(true); setError(''); clearSelection(true); invalidate();
    const snapshotEpoch = epoch.current;
    try {
      const available = await p.request({ method: 'eth_accounts' });
      if (current !== operation.current || snapshotEpoch !== epoch.current || activeProvider.current !== p) return;
      const selected = authorizedAccount(available, account);
      if (!selected) throw new Error('This account is no longer authorized. Choose an available account again.');
      selectedAccount.current = selected; setSelectionRevision(n => n + 1);
      readOnlyRestored.current.delete(p);
      const wallet = wallets.find(wallet => wallet.provider === p);
      const key = wallet && providerKeys(wallet).find(key => wallets.filter(wallet => providerKeys(wallet).includes(key)).length === 1);
      if (key) {
        try { sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ provider: key, account: selected })); } catch { /* Explicit selection works without persistence. */ }
      }
      await ensurePolygon(p, selected, current);
      await refresh(p);
    } catch (e) {
      if (current !== operation.current) return;
      if (walletRpcCode(e) === 4001) { cancelConnection(); return; }
      if (activeProvider.current === p) { try { await refresh(p); } catch { /* Preserve the switch error. */ } }
      if (current === operation.current) setError(walletError(e));
    } finally { settle(current); }
  };
  const chooseAnotherAccount = async () => {
    const p = activeProvider.current;
    if (!p || busy || flight.current !== null) return;
    const current = ++operation.current;
    flight.current = current;
    setBusy(true); setError('');
    let granted = false;
    try {
      // Permissions are an optional extension, not account selection. Do not
      // destroy an existing explicit choice before the wallet accepts them.
      // Only this explicit user action may open the wallet permission chooser.
      await p.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      granted = true;
      if (current !== operation.current || activeProvider.current !== p) return;
      clearSelection(true); invalidate();
      await refresh(p, true); // Account choices must not wait for network reads.
    } catch (e) {
      if (current !== operation.current || activeProvider.current !== p) return;
      const code = walletRpcCode(e);
      // A failed optional RPC must not trigger eth_requestAccounts or another
      // prompt. Revalidate membership read-only, preserving the previous choice
      // unless the wallet really removed it. Expose the local explicit chooser.
      try { await refresh(p, true); } catch { /* Keep last display; signing still preflights membership. */ }
      if (current !== operation.current || activeProvider.current !== p) return;
      setAccountChoiceOpen(true);
      const recovery = ' Choose an authorized account below, or manage connected accounts in your wallet and retry.';
      setError(granted ? 'Account permissions were accepted, but the account/network refresh failed. Account access and network connectivity are separate. Choose an available account below and check the wallet network.'
        : code === 4001 ? `Account permission request declined.${recovery}`
          : code === 4200 || code === -32601 || code === -32004 ? `This wallet does not support account permission selection.${recovery}`
            : code === -32002 ? `A wallet request is already pending. Open MetaMask and complete or cancel it before requesting permissions again.${recovery}`
              : code === 4100 ? `Account permission request was not authorized by the wallet.${recovery}`
                : code === -32602 ? `The wallet rejected the account permission parameters. This provider may not support the standard permission request.${recovery}`
                  : `Account permission request not completed${code === null ? ' (no wallet error code)' : ` (wallet code ${code})`}.${recovery}`);
    } finally { settle(current); }
  };
  const changeAccount = async () => {
    const p = activeProvider.current;
    if (!p || busy || flight.current !== null) return;
    const current = ++operation.current;
    // Opening a local chooser is not revocation or a new address choice.
    // Keep the selected account/hint until an explicit address click, and read
    // fresh membership: wallets need not emit an event before this user action.
    setAccountChoiceOpen(true); setBusy(true); setError('');
    try { await refresh(p, true); }
    catch { if (current === operation.current && activeProvider.current === p) setError('Authorized accounts could not be fully refreshed. Check the wallet connection, or choose an available account below; it will be revalidated.'); }
    finally { if (current === operation.current) setBusy(false); }
  };
  return { ...state, chainId: flight.current !== null ? null : state.chainId, accounts, accountChoiceOpen, connectingDefault, notice, clearNotice: () => setNotice(''), cancelConnection, closeAccountChoices: () => setAccountChoiceOpen(false), selectionRevision, wallets, provider, error, busy, setPage, connect, chooseAccount, chooseAnotherAccount, changeAccount, switchPolygon, disconnect: () => { endConnection(); setError(''); setNotice(''); } };
}
export type WalletController = ReturnType<typeof useWallet>;
