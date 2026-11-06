import { useRef, useState } from 'react';
import { TOKENS } from '../swap/registry';

export const tokenLabels = { USDC: 'Circle USDC™', USDT: 'Tether USD₮', NIM: 'Nimiq' };
export type TokenSymbol = keyof typeof tokenLabels;

export function TokenAvatar({ symbol }: { symbol: TokenSymbol }) {
  return <span className="token-avatar token-avatar-text" aria-hidden="true">{symbol === 'USDT' ? 'USDT0' : symbol}</span>;
}

export function TokenPicker({ value, options, onChange, label }: { value: TokenSymbol; options: TokenSymbol[]; onChange: (symbol: TokenSymbol) => void; label: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <>
    <button type="button" ref={trigger} className="token-select token-picker-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} data-token={value} onClick={() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLButtonElement>('.token-picker-option[aria-pressed="true"]')?.focus({ preventScroll: true }); setOpen(true); }}>
      <TokenAvatar symbol={value} /><span>{value}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <dialog ref={dialog} className="token-picker-dialog" aria-label={`${label} selection`} onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }} onClick={event => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
      <div className="token-picker-heading"><h3>Select a token</h3><button type="button" className="token-picker-close" aria-label="Close token selection" onClick={close}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>

      <div className="token-picker-caption">Tokens on Polygon</div>
      <div className="token-picker-list">{options.map(symbol => <button type="button" className="token-picker-option" key={symbol} data-token={symbol} aria-label={`Select ${symbol}`} aria-pressed={symbol === value} onClick={() => { onChange(symbol); close(); }}><TokenAvatar symbol={symbol} /><span className="token-picker-identity"><strong>{tokenLabels[symbol]}</strong><span>{symbol === 'USDT' ? 'USDT0' : symbol}{symbol === 'NIM' ? <span> · Available soon</span> : <span className="token-picker-address"> · {TOKENS[symbol].address.slice(0, 6)}…{TOKENS[symbol].address.slice(-4)}</span>}</span></span>{symbol === value && <svg className="token-picker-check" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>}</button>)}</div>
    </dialog>
  </>;
}
