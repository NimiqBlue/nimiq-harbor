// Synthetic test-only quote. Not a captured live response or liquidity evidence.
import { type RawQuote } from '../src/fusion/adapter.js';
import { SETTLEMENT, SPENDER, quoteRequest } from '../src/fusion/policy.js';
import { TOKENS } from '../src/swap/registry.js';
export const request=quoteRequest.parse({chainId:137,account:'0x1111111111111111111111111111111111111111',tokenIn:TOKENS.USDC.address,tokenOut:TOKENS.USDT.address,amount:'1000000',slippageBps:250});
export function fixture():RawQuote {
  const preset={auctionDuration:180,startAuctionIn:12,bankFee:'0',initialRateBump:100000,auctionStartAmount:'1100000',auctionEndAmount:'990000',tokenFee:'0',points:[],allowPartialFills:true,allowMultipleFills:true,exclusiveResolver:null,gasCost:{gasBumpEstimate:0,gasPriceEstimate:'0'}};
  return {fromTokenAmount:request.amount,toTokenAmount:'1000000',marketAmount:'1000000',recommended_preset:'fast',presets:{fast:{...preset},medium:{...preset},slow:{...preset}},prices:{usd:{fromToken:'1',toToken:'1'}},volume:{usd:{fromToken:'1',toToken:'1'}},settlementAddress:SETTLEMENT,whitelist:['0x2222222222222222222222222222222222222222'],quoteId:'synthetic-not-live',autoK:2.5,fee:{receiver:SPENDER,bps:0,whitelistDiscountPercent:0},integratorFee:0,integratorFeeShare:0};
}
