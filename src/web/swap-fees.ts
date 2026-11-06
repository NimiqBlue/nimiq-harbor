import { formatUnits } from 'viem';


type FeeQuote = { expectedAmount: string; tokenFee?: string | undefined; bankFee?: string | undefined };
const uint = /^(?:0|[1-9][0-9]{0,77})$(?![\s\S])/;
const unavailable = { text: 'Harbor: 0.00% · provider shown with quote', title: undefined };

/** Presentation only. Included costs / gross quoted output, in the same output-token base units.
 * providerFeeBps is resolver-side metadata, not this user's effective included-cost rate.
 * Never derive a fee from the input/output price difference or slippage-adjusted minimum.
 */
export function swapFees(quote: FeeQuote | null, decimals: number, symbol: string): { text: string; title: string | undefined } {
  if (!quote || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
      ![quote.expectedAmount, quote.tokenFee, quote.bankFee].every(value => typeof value === 'string' && uint.test(value) && BigInt(value) < 2n ** 256n)) return unavailable;
  const gross = BigInt(quote.expectedAmount);
  if (gross <= 0n) return unavailable;
  const costs = BigInt(quote.tokenFee!) + BigInt(quote.bankFee!);
  const exactAmount = formatUnits(costs, decimals);
  // Five fractional percentage digits; truncate with bigint, preserving positive dust.
  const scaledPercent = costs * 100n * 100000n / gross;
  const percent = costs === 0n ? '0.00%' : scaledPercent === 0n ? '< 0.00001%' : `≈ ${formatUnits(scaledPercent, 5)}%`;
  return {
    text: `Provider: ${percent} included · Harbor: 0.00%`,
    title: `Exact included provider costs: ${exactAmount} ${symbol}. Percentage basis: (tokenFee + bankFee) / gross expectedAmount × 100 = ${costs} / ${gross} × 100%; truncated to five decimals. Indicative quote, not an additional charge. Harbor charges no fee.`,
  };
}
