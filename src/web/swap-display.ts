import { formatUnits, parseUnits } from 'viem';

/** Visual truncation only; never feed this value into execution or input state. */
export function displayAmount(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$(?![\s\S])/.test(value)) return value;
  const [whole = '0', fraction = ''] = value.split('.');
  const clipped = fraction.slice(0, 5).replace(/0+$/, '');
  if (whole === '0' && !clipped && /[1-9]/.test(fraction)) return '< 0.00001';
  return clipped ? `${whole}.${clipped}` : whole;
}

/** Unknown/malformed balances stay unknown; zero is a confirmed balance. */
export function percentageAmount(balance: string | undefined, decimals: number, percent: 25 | 50 | 75 | 100): string | null {
  if (balance === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$(?![\s\S])/.test(balance)) return null;
  if ((balance.split('.')[1]?.length ?? 0) > decimals) return null;
  return formatUnits(parseUnits(balance, decimals) * BigInt(percent) / 100n, decimals);
}

/** Exact quote ratio, not FX. Decimal display is truncated, never a fill promise. */
export function quoteRate(amountIn: string, inputDecimals: number, amountOut: string, outputDecimals: number) {
  if (!/^[1-9][0-9]*$(?![\s\S])/.test(amountIn) || !/^[1-9][0-9]*$(?![\s\S])/.test(amountOut)) return null;
  const numerator = BigInt(amountOut) * 10n ** BigInt(inputDecimals);
  const denominator = BigInt(amountIn) * 10n ** BigInt(outputDecimals);
  let a = numerator, b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  const digits = 12;
  const scaled = numerator * 10n ** BigInt(digits) / denominator;
  return {
    display: scaled === 0n ? '< 0.000000000001' : formatUnits(scaled, digits),
    exact: `${numerator / a}/${denominator / a}`,
    amounts: `${formatUnits(BigInt(amountOut), outputDecimals)} / ${formatUnits(BigInt(amountIn), inputDecimals)}`,
  };
}
