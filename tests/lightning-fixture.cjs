// Entirely synthetic: no real invoice, swap, wallet or provider evidence.
const bolt11 = require('bolt11');
const crypto = require('node:crypto');
const preimage = '42'.repeat(32);
const hash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
const historical = Date.UTC(2026, 0, 1);
function makeInvoice(timestamp = historical / 1000, paymentHash = hash) {
  return bolt11.sign(bolt11.encode({
    satoshis: 42000, timestamp,
    tags: [
      { tagName: 'payment_hash', data: paymentHash },
      { tagName: 'description', data: 'Synthetic Harbor offline safety fixture — never pay' },
      { tagName: 'expire_time', data: 3600 },
    ],
  }), '11'.repeat(32)).paymentRequest;
}
const invoice = makeInvoice();
const expiredInvoice = makeInvoice(1);
const differentInvoice = makeInvoice(historical / 1000, '33'.repeat(32));
const exact = {
  id: '11111111-2222-4333-8444-555555555555', hash, preimage, status: 'FINISHED',
  contracts: [
    { asset: 'BTC_LN', id: invoice, recipient: JSON.stringify({ address: invoice }), amount: '0.00042000', status: 'REDEEMED' },
    { asset: 'NIM', id: 'synthetic-contract-only', status: 'REDEEMED' },
  ],
};
module.exports = { historical, invoice, expiredInvoice, differentInvoice, exact, makeInvoice };
