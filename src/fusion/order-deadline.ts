import { FusionOrder, MakerTraits } from '@1inch/fusion-sdk';

export class OrderDeadlineUnavailable extends Error {}

/** Only unsigned SDK orders enter here. Keep the provider's complete auction,
 * extension, nonce, fees and source/salt; change only its signed expiration.
 * Fusion supports an expiration delay after auction end. Never truncate an
 * auction to manufacture support for a user's shorter deadline. */
export function withExactOrderDeadline(order: FusionOrder, deadline: number, permitDeadline: number, nowSeconds: number) {
  if (![deadline, permitDeadline, nowSeconds].every(Number.isSafeInteger) || deadline <= 0 || deadline > permitDeadline || deadline - nowSeconds < 30) throw new Error('Order deadline exceeds permit authority or is too close to expiry');
  if (order.auctionEndTime > BigInt(deadline)) throw new OrderDeadlineUnavailable('Provider auction does not fit the selected deadline. No shortened auction or extended deadline is allowed.');
  const data = order.build();
  const makerTraits = new MakerTraits(BigInt(data.makerTraits)).withExpiration(BigInt(deadline)).asBigInt().toString();
  const exact = FusionOrder.fromDataAndExtension({ ...data, makerTraits }, order.extension);
  if (exact.deadline !== BigInt(deadline) || exact.auctionEndTime !== order.auctionEndTime || exact.extension.encode() !== order.extension.encode()) throw new Error('SDK exact deadline reconstruction mismatch');
  return exact;
}
