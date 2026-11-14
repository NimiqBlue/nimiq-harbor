import './browser-globals.js';
import bolt11 from 'bolt11';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function invoice(raw, requireFresh = true) {
  if (typeof raw !== 'string' || raw.length > 12000) throw Error('Paste a valid fixed-amount mainnet BOLT11 invoice.');
  const text = raw.trim().replace(/^lightning:/i, '');
  if (!/^lnbc[0-9]/i.test(text)) throw Error('Only fixed-amount Bitcoin mainnet BOLT11 invoices are supported here.');
  let d; try { d = bolt11.decode(text); } catch { throw Error('Invalid Lightning invoice. Check the complete invoice.'); }
  if (!d.millisatoshis || BigInt(d.millisatoshis) <= 0n) throw Error('An invoice with a fixed amount is required.');
  const expiry = d.timeExpireDate || d.timestamp + 3600;
  if (requireFresh && expiry * 1000 <= Date.now()) throw Error('This invoice has expired. Check an existing payment below; do not repay it.');
  const hash = d.tags.find(t => t.tagName === 'payment_hash')?.data;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) throw Error('Invalid payment hash.');
  return {text:text.toLowerCase(), hash:hash.toLowerCase(), msat:BigInt(d.millisatoshis), expiry};
}
function msat(btc) {
  if (typeof btc !== 'string' || !/^[0-9]+(?:\.[0-9]{1,11})?$/.test(btc)) throw Error('amount');
  const [a,b=''] = btc.split('.'); return BigInt(a)*100000000000n+BigInt(b.padEnd(11,'0'));
}
export async function verifySettlement(record, data) {
  // Every binding is necessary: a finished unrelated swap or a status alone is not a receipt.
  const inv = invoice(record.invoice, false);
  if (!UUID.test(record.swapId) || data?.id !== record.swapId || !Array.isArray(data.contracts)) return 'unknown';
  const ln = data.contracts.filter(c => c.asset === 'BTC_LN');
  if (ln.length !== 1) return 'unknown';
  const c = ln[0]; let recipient;
  try { recipient = JSON.parse(c.recipient)?.address; } catch { return 'unknown'; }
  if (typeof recipient !== 'string' || recipient.toLowerCase() !== inv.text || typeof c.id !== 'string' || c.id.toLowerCase() !== inv.text || data.hash !== inv.hash) return 'unknown';
  try { if (msat(c.amount) !== inv.msat) return 'unknown'; } catch { return 'unknown'; }
  if (data.status === 'FINISHED') {
    if (c.status !== 'REDEEMED' || data.contracts.length < 2 || !data.contracts.every(x => x.status === 'REDEEMED') || !/^[a-f0-9]{64}$/i.test(data.preimage || '')) return 'unknown';
    const bytes = Uint8Array.from(data.preimage.match(/../g), h => parseInt(h,16));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
    return digest === inv.hash ? 'paid' : 'unknown';
  }
  if (['NEW','CONFIRMED','FUNDED','STARTED','PENDING','AWAITING_FUNDING','SIGNING','SIGNED'].includes(data.status)) return 'pending';
  return 'unknown';
}
