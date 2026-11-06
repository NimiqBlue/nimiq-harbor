// Independent recipient protection: slippage then disclosed fixed costs.
// SDK resolver fees are on top of its endpoint, not grounds to lower this floor.
// Validate fee metadata without using it to weaken recipient protection.
export function fusionNetFloor(gross: string, slippageBps: number, tokenFee: string, bankFee: string, resolverFeeBps = 0): bigint {
  const uint = /^(0|[1-9][0-9]{0,77})$/;
  if (![gross, tokenFee, bankFee].every(v => uint.test(v) && BigInt(v) < 2n ** 256n) || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 2000 || !Number.isInteger(resolverFeeBps) || resolverFeeBps < 0 || resolverFeeBps > 1000) throw new Error('Invalid quote economics');
  const output = BigInt(gross), costs = BigInt(tokenFee) + BigInt(bankFee);
  const floor = output * BigInt(10000 - slippageBps) / 10000n - costs;
  if (output <= 0n || costs * 10n > output || floor <= 0n) throw new Error('Nonpositive or excessive-cost net quote');
  return floor;
}
