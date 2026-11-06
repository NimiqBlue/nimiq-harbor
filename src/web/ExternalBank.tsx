import type { HarborProvider } from './wallet';
import './external-bank.css';

const configuredWidgetKey = import.meta.env.VITE_MTPELERIN_KEY?.trim();
// Never send placeholder or malformed activation keys to the provider.
const widgetKey = configuredWidgetKey && !/^(undefined|null)$/i.test(configuredWidgetKey) && !/\s/.test(configuredWidgetKey)
  ? configuredWidgetKey
  : undefined;
const widgetUrl = new URL('https://widget.mtpelerin.com/');
for (const [key, value] of Object.entries({ tab: 'sell', tabs: 'buy,sell,swap', bsc: 'EUR', bdc: 'USDT', wsc: 'USDT', wdc: 'USDC', ssc: 'USDT', sdc: 'EUR', crys: 'USDT,USDC,WBTC,POL', curs: 'EUR,USD', snet: 'matic_mainnet', dnet: 'matic_mainnet', net: 'matic_mainnet', nets: 'matic_mainnet' })) widgetUrl.searchParams.set(key, value);

if (widgetKey) widgetUrl.searchParams.set('_ctkn', widgetKey);

export function ExternalBank({ wallet: _wallet, revision }: { wallet: { provider: HarborProvider | null; account: `0x${string}` | null; selectionRevision: number }; revision: number }) {
  return <section className="card external-bank" aria-label="Bank with Mt Pelerin">
    {widgetKey ? <div className="external-bank-widget"><iframe key={revision} title="Mt Pelerin buy, sell and swap" src={widgetUrl.toString()} allow="usb; ethereum; clipboard-write; payment; microphone; camera" referrerPolicy="no-referrer" /></div> : <p role="alert">Mt Pelerin is unavailable: the widget activation key is not configured for this build.</p>}
  </section>;
}
