const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exact, invoice: text, expiredInvoice, differentInvoice } = require('./lightning-fixture.cjs');
const modules = Promise.all([
  import('../src/web/lightning/settlement.js'), import('../src/web/lightning/rejection.js'),
]);
test('fixed mainnet invoice validation; recovery permits expiry, never fresh payment', async () => {
  const [{ invoice }] = await modules;
  const value = invoice(`lightning:${text.toUpperCase()}`, false);
  assert.equal(value.text, text); assert.equal(value.msat, 42000000n); assert.equal(value.hash, exact.hash);
  assert.throws(() => invoice(expiredInvoice), /expired/);
  for (const raw of [null, '', 'lnbc123wrong', 'lntb123wrong', 'lnbc', 'x'.repeat(12001)]) assert.throws(() => invoice(raw));
});
test('exact redeemed response and SHA256(preimage) required; status alone is insufficient', async () => {
  const [{ verifySettlement }] = await modules;
  const record = { invoice: text, swapId: exact.id };
  assert.equal(await verifySettlement(record, exact), 'paid');
  for (const mutate of [
    x => { x.id = '00000000-0000-0000-0000-000000000000'; },
    x => { x.hash = '00'.repeat(32); }, x => { x.preimage = '00'.repeat(32); },
    x => { x.status = 'FAILED'; }, x => { x.contracts[1].status = 'FUNDED'; },
    x => { x.contracts[0].status = 'FUNDED'; }, x => { x.contracts[0].amount = '0.000420001'; },
    x => { x.contracts[0].amount = 0.00042; },
    x => { x.contracts[0].id = differentInvoice; },
    x => { x.contracts[0].recipient = JSON.stringify({ address: differentInvoice }); },
    x => { x.contracts.push(structuredClone(x.contracts[0])); },
    x => { x.contracts = [x.contracts[0]]; },
  ]) {
    const data = structuredClone(exact); mutate(data);
    assert.equal(await verifySettlement(record, data), 'unknown');
  }
  const pending = structuredClone(exact); pending.status = 'PENDING'; pending.contracts.forEach(x => { x.status = 'FUNDED'; });
  assert.equal(await verifySettlement(record, pending), 'pending');
});
test('only physical normalized permission refusal is retryable, with durable provenance', async () => {
  const [, { prePaymentRejection, retryable, recoveryIdentity }] = await modules;
  assert.equal(prePaymentRejection({ name: 'NimiqProviderError', type: 'PERMISSION_DENIED', code: 4001 }), true);
  for (const error of [null, { code: 4001 }, { name: 'NimiqProviderError', type: 'PERMISSION_DENIED', code: '4001' },
    { name: 'NimiqProviderError', type: 'INVALID_TRANSACTION', code: 4001 },
    { name: 'NimiqProviderError', type: 'PERMISSION_DENIED', code: 4001, data: { swapId: exact.id } },
    { message: 'cancelled' }, { data: { originalError: { code: 4001 } } },
  ]) assert.equal(prePaymentRejection(error), false);
  const record = { state: 'cancelled', rejection: 'native-pre-payment-v1', attemptId: 'synthetic-attempt' };
  assert.equal(retryable(record), true);
  assert.equal(retryable({ ...record, swapId: exact.id }), false);
  assert.equal(retryable({ ...record, transaction: '11'.repeat(32) }), false);
  assert.equal(retryable({ state: 'cancelled' }), false);
  assert.deepEqual(recoveryIdentity({ type: 'DUPLICATE_PAYMENT', data: { swapId: exact.id, hash: '22'.repeat(32), extra: 'ignored' } }), { swapId: exact.id, transaction: '22'.repeat(32) });
  assert.deepEqual(recoveryIdentity({ type: 'PERMISSION_DENIED', data: { swapId: exact.id } }), {});
});
