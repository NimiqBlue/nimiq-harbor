import { useEffect, useState, useRef } from 'react';
import { ExternalBank } from './ExternalBank';
import { ManualBankSend } from './ManualPolygonSend';
import { PersonalMessageSign } from './PersonalMessageSign';
import './external-bank.css';
import './wallet-connection.css';
import './sign-message.css';
import { SwapPanel } from './SwapPanel';
import { LighthouseScene } from './LighthouseScene';
import { useWallet } from './wallet';
import { initialLanguage, translations } from './i18n';
export function App() {
  const [bankRevision, setBankRevision] = useState(0);
  const [page, setPageState] = useState<'swap' | 'bank'>('swap');
  const wallet = useWallet(page === 'bank' ? 'external' : 'swap');
  const setPage = (next: 'swap' | 'bank') => { wallet.setPage(next === 'bank' ? 'external' : 'swap'); setPageState(next); };
  const [language] = useState(() => initialLanguage((window as Window & { nimiqPay?: { language?: string } }).nimiqPay?.language));
  const [walletPicker, setWalletPicker] = useState(false); const t = translations[language];
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenu = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const signDialog = useRef<HTMLDialogElement>(null);
  const [signOpen, setSignOpen] = useState(false);
  useEffect(() => {
    if (!signOpen) return;
    const dialog = signDialog.current;
    const viewport = window.visualViewport;
    const update = () => {
      dialog?.style.setProperty('--sign-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      dialog?.style.setProperty('--sign-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('#personal-message-title')?.focus({ preventScroll: true });
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [signOpen]);
  useEffect(() => { setAccountOpen(false); setWalletPicker(false); }, [wallet.account, wallet.provider]);
  useEffect(() => {
    if (!accountOpen && !walletPicker) return;
    const outside = (event: PointerEvent) => { if (!accountMenu.current?.contains(event.target as Node)) { setAccountOpen(false); setWalletPicker(false); } };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setAccountOpen(false); setWalletPicker(false); accountButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [accountOpen, walletPicker]);
  const closeAccount = () => { setAccountOpen(false); setWalletPicker(false); accountButton.current?.focus(); };
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="header"><a href="/" className="brand" aria-label="Nimiq Harbor home"><span className="asset-placeholder" aria-hidden="true">H</span><span><strong>Harbor demo</strong></span></a><h1 className="header-tagline" lang="en">{t.tagline}</h1><div className="header-actions"><span className="header-mode"><span className="status-dot" />Polygon</span><div className="header-wallet" ref={accountMenu}><button ref={accountButton} className="wallet-button" disabled={wallet.busy} aria-expanded={wallet.account ? accountOpen : walletPicker} aria-controls={wallet.account ? 'wallet-account-popover' : 'wallet-selection'} onClick={() => { if (wallet.account) { setAccountOpen(!accountOpen); setWalletPicker(false); } else if (wallet.wallets.length !== 1) setWalletPicker(!walletPicker); else void wallet.connect(undefined, true); }}><span className="nimiq-pay-mark asset-placeholder" aria-hidden="true">Wallet</span>{wallet.busy ? 'Connecting…' : wallet.account ? `${wallet.account.slice(0, 6)}…${wallet.account.slice(-4)}` : t.connect}</button>
      {wallet.account && <div id="wallet-account-popover" className="wallet-account-popover" hidden={!accountOpen}><section aria-label="Wallet accounts"><div className="account-popover-heading account-popover-close"><button className="text-button" aria-label="Close account menu" onClick={closeAccount}>×</button></div><code className="selected-wallet-address">{wallet.account}</code><ManualBankSend wallet={wallet} onOpen={closeAccount} restoreFocus={() => accountButton.current?.focus()} /><button className="text-button" onClick={() => { closeAccount(); setSignOpen(true); }}><span className="wallet-action-icon asset-placeholder" aria-hidden="true">✎</span>Sign a message</button><details className="wallet-change-options"><summary><span className="wallet-action-icon asset-placeholder" aria-hidden="true">↔</span>Change wallet or account</summary><button className="text-button" disabled={wallet.busy} onClick={() => { closeAccount(); wallet.changeAccount(); }}><span className="wallet-action-icon asset-placeholder" aria-hidden="true">+</span>Choose authorized account</button><button className="text-button" disabled={wallet.busy} onClick={() => { closeAccount(); void wallet.chooseAnotherAccount(); }}><span className="wallet-action-icon asset-placeholder" aria-hidden="true">+</span>Authorize another account in wallet</button><button className="text-button" aria-expanded={walletPicker} onClick={() => setWalletPicker(!walletPicker)}><span className="wallet-action-icon asset-placeholder" aria-hidden="true">↻</span>Choose another wallet</button>{walletPicker && <section aria-label="Wallet selection"><p className="fine-print">Open Harbor inside Nimiq Pay, or choose a detected browser wallet.</p>{wallet.wallets.map(w => <button className="secondary" disabled={wallet.busy} key={w.id} onClick={() => { closeAccount(); void wallet.connect(w.provider, true); }}>{w.name}</button>)}</section>}</details><button className="text-button account-disconnect" onClick={() => { closeAccount(); wallet.disconnect(); }}><span className="wallet-action-icon asset-placeholder" aria-hidden="true">×</span>Disconnect from Harbor</button></section></div>}
      {walletPicker && !wallet.account && <div id="wallet-selection" className="wallet-account-popover"><section aria-label="Wallet selection"><div className="account-popover-heading"><h2>Choose a wallet</h2><button className="text-button" aria-label="Close wallet menu" onClick={closeAccount}>×</button></div><p className="fine-print">Open Harbor inside Nimiq Pay, or select a detected browser wallet below.</p>{wallet.wallets.length === 0 && <p role="status" className="fine-print">No browser wallet detected. Open Nimiq Pay or unlock/enable your wallet extension, then retry. WalletConnect and hosted accounts are not used.</p>}{wallet.wallets.map(w => <button className="secondary" disabled={wallet.busy} key={w.id} onClick={() => { closeAccount(); void wallet.connect(w.provider, true); }}>{w.name}</button>)}</section></div>}
      </div></div></header>
    <dialog ref={signDialog} className="manual-send-dialog sign-message-dialog" aria-label="Sign a message" onClose={() => { setSignOpen(false); accountButton.current?.focus({ preventScroll: true }); }}><button type="button" className="text-button sign-dialog-close" aria-label="Close message signer" onClick={() => signDialog.current?.close()}>×</button>{signOpen && <PersonalMessageSign wallet={wallet} />}</dialog>
    {wallet.provider && !wallet.connectingDefault && (!wallet.account || wallet.accountChoiceOpen) && <section className="wallet-picker wallet-accounts" aria-label="Wallet accounts"><h2>Choose an account</h2>{wallet.account && <><p className="fine-print">Current selection is unchanged:</p><code className="selected-wallet-address">{wallet.account}</code></>}<p className="fine-print">Select the address Harbor should use. Harbor sees only accounts authorized by your wallet. If your address is missing, manage connected accounts in your wallet, then retry.</p>{wallet.accounts.map(account => <button className="secondary account-option" disabled={wallet.busy} key={account.toLowerCase()} onClick={() => void wallet.chooseAccount(account)}>Use {account}</button>)}<button className="text-button" disabled={wallet.busy} onClick={() => void wallet.chooseAnotherAccount()}>Choose another account in wallet</button>{wallet.account && <button className="text-button" onClick={wallet.closeAccountChoices}>Keep current account</button>}<button className="text-button" onClick={() => { wallet.disconnect(); setWalletPicker(false); }}><span className="wallet-action-icon asset-placeholder" aria-hidden="true">×</span>Disconnect from Harbor</button></section>}
    <main id="main">
      <div className="workspace"><aside className="harbor-scene" aria-hidden="true"><LighthouseScene /></aside>
        <div className="work-column"><nav className="tabs" aria-label="Harbor services"><button aria-current={page === 'swap' ? 'page' : undefined} className={page === 'swap' ? 'active' : ''} onClick={() => setPage('swap')}><span className="swap-tab-icon asset-placeholder" aria-hidden="true">⇄</span> {t.swap}</button><button aria-current={page === 'bank' ? 'page' : undefined} className={page === 'bank' ? 'active' : ''} onClick={() => setPage('bank')}><span className="bank-tab-icon asset-placeholder" aria-hidden="true">◇</span> Bank</button>{page === 'bank' && <button type="button" className="bank-tab-reload" aria-label="Reload Mt Pelerin" title="Reload Mt Pelerin" onClick={() => { if (window.confirm('Reload Mt Pelerin? Unsaved information may be lost.')) setBankRevision(value => value + 1); }}><span className="asset-placeholder" aria-hidden="true">↻</span></button>}</nav>
          {wallet.connectingDefault && <div className="wallet-connection-progress" role="status"><span>Complete the request in your wallet.</span><button className="text-button" onClick={wallet.cancelConnection}>Cancel connection</button></div>}
          {wallet.notice && <div className="wallet-notice" role="status"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v6m0-10v1"/></svg><div><strong>{wallet.notice}</strong><span>{wallet.busy ? 'Close the pending request in your wallet.' : 'Click Connect wallet to try again.'}</span></div><button className="text-button" aria-label="Dismiss connection notice" onClick={wallet.clearNotice}>×</button></div>}
          {wallet.error && <div className="alert error wallet-alert" role="alert">{wallet.error}</div>}
          {wallet.account && !wallet.connectingDefault && wallet.chainId !== 137 && <div className="swap-network-recovery"><button className="primary full" disabled={wallet.busy} onClick={() => void wallet.switchPolygon()}>Switch wallet to Polygon mainnet</button></div>}
          {page === 'swap' ? <SwapPanel wallet={wallet} language={language} /> : <ExternalBank wallet={wallet} revision={bankRevision} />}
        </div></div>
    </main>
    <footer className="fine-print"><nav aria-label="Legal"><a href="/terms/">Terms</a> · <a href="/privacy/">Privacy</a></nav></footer>
  </div>;
}
