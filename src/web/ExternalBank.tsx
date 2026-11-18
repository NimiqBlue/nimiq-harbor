import { useState, type KeyboardEvent } from 'react';
import type { HarborProvider } from './wallet';
import './external-bank.css';

const configuredWidgetKey = import.meta.env.VITE_MTPELERIN_KEY?.trim();
// Never send placeholder or malformed activation keys to the provider.
const widgetKey = configuredWidgetKey && !/^(undefined|null)$/i.test(configuredWidgetKey) && !/\s/.test(configuredWidgetKey)
  ? configuredWidgetKey
  : undefined;

const modes = ['buy', 'sell', 'swap'] as const;
type BankMode = typeof modes[number];

function bankWidgetUrl(mode: BankMode, activationKey: string) {
  const buy = mode === 'buy';
  const url = new URL('https://widget.mtpelerin.com/');
  url.search = new URLSearchParams({
    rfr: 'yZkss3Rs',
    tab: mode,
    tabs: mode,
    bsc: 'EUR',
    bdc: 'USDT',
    wsc: 'sat',
    wdc: 'USDT',
    ssc: 'sat',
    sdc: 'EUR',
    crys: buy ? 'USDT,USDC,BTC,POL,XAUt,PAXG,ETH,EURC' : 'USDT,USDC,BTC,POL,sat,XAUt,PAXG,ETH,EURC',
    snet: buy ? 'matic_mainnet' : 'lightning_mainnet',
    dnet: 'matic_mainnet',
    net: 'matic_mainnet',
    nets: buy ? 'matic_mainnet,mainnet,bitcoin_mainnet' : 'matic_mainnet,lightning_mainnet,mainnet,bitcoin_mainnet',
    [mode === 'buy' ? 'bsa' : mode === 'sell' ? 'sda' : 'wda']: '100',
    _ctkn: activationKey,
  }).toString();
  // Omit `curs` so the provider supplies its full fiat list. BUY has no Lightning address placeholder.
  if (!buy) url.searchParams.set('addr', 'ln@invoice.pay');
  return url.toString();
}

export function ExternalBank({ revision }: { wallet: { provider: HarborProvider | null; account: `0x${string}` | null; selectionRevision: number }; revision: number }) {
  const [active, setActive] = useState<BankMode>('sell');
  const [visited, setVisited] = useState<BankMode[]>(['sell']);

  function select(mode: BankMode) {
    setVisited(previous => previous.includes(mode) ? previous : [...previous, mode]);
    setActive(mode);
  }

  function onModeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = modes.indexOf(active);
    let next: BankMode | undefined;
    switch (event.key) {
      case 'ArrowRight': next = modes[(index + 1) % modes.length]; break;
      case 'ArrowLeft': next = modes[(index + modes.length - 1) % modes.length]; break;
      case 'Home': next = 'buy'; break;
      case 'End': next = 'swap'; break;
      default: return;
    }
    if (!next) return;
    event.preventDefault();
    select(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`#bank-mode-${next}`)?.focus();
  }

  return <section className="card external-bank" aria-label="Bank with Mt Pelerin">
    {widgetKey ? <>
      <div className="bank-mode-selector" role="tablist" aria-label="Bank transaction" onKeyDown={onModeKeyDown}>
        {modes.map(mode => <button
          key={mode}
          type="button"
          role="tab"
          id={`bank-mode-${mode}`}
          aria-selected={active === mode}
          aria-controls={`bank-panel-${mode}`}
          tabIndex={active === mode ? 0 : -1}
          onClick={() => select(mode)}
        >{mode.toUpperCase()}</button>)}
      </div>
      {visited.map(mode => <div
        key={mode}
        className="external-bank-widget"
        role="tabpanel"
        id={`bank-panel-${mode}`}
        aria-labelledby={`bank-mode-${mode}`}
        data-bank-mode={mode}
        hidden={active !== mode}
        aria-hidden={active !== mode}
      >
        <iframe
          key={`${mode}:${revision}`}
          title="Mt Pelerin buy, sell and swap"
          aria-label={`Mt Pelerin ${mode}`}
          src={bankWidgetUrl(mode, widgetKey)}
          allow="usb; ethereum; clipboard-write; payment; microphone; camera"
          referrerPolicy="no-referrer"
        />
      </div>)}
    </> : <p role="alert">Mt Pelerin is unavailable: the widget activation key is not configured for this build.</p>}
  </section>;
}
