import { useEffect, useState } from 'react';
import { createPublicClient, formatUnits, http, type Address } from 'viem';
import { polygon } from 'viem/chains';

function displayPol(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const decimals = fraction.slice(0, 5).replace(/0+$/, '');
  if (whole === '0' && !decimals && /[1-9]/.test(fraction)) return '<0.00001';
  return decimals ? `${whole}.${decimals}` : whole;
}

// This is an independent, read-only Polygon native balance, not a swap asset.
export function PolBalance({ account, revision }: { account: Address | null; revision: number }) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: string | null } | null>(null);
  const key = `${account?.toLowerCase() ?? ''}:${revision}:${refresh}`;
  useEffect(() => {
    if (!account) return;
    let active = true;
    const client = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 15000, retryCount: 0 }) });
    void client.getBalance({ address: account }).then(
      value => { if (active) setResult({ key, value: formatUnits(value, 18) }); },
      () => { if (active) setResult({ key, value: null }); },
    );
    return () => { active = false; };
  }, [account, key]);
  const current = result?.key === key ? result : null;
  return <div className="pol-balance" aria-label="Polygon POL balance">
    <span>Polygon POL balance: <strong aria-live="polite">{!account ? 'Connect wallet' : !current ? 'Checking…' : current.value === null ? 'Unavailable' : `${displayPol(current.value)} POL`}</strong></span>
    {account && <button type="button" className="text-button" onClick={() => setRefresh(value => value + 1)}>Refresh POL balance</button>}
  </div>;
}
