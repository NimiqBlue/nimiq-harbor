import { parseAbi } from "viem";
export const algebraFactoryAbi = parseAbi([
  "function poolByPair(address tokenA,address tokenB) view returns (address pool)",
]);
export const algebraPoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function globalState() view returns (uint160 price,int24 tick,uint16 fee,uint16 timepointIndex,uint8 communityFeeToken0,uint8 communityFeeToken1,bool unlocked)",
]);
export const algebraQuoterAbi = parseAbi([
  "function factory() view returns (address)",
  "function poolDeployer() view returns (address)",
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint256 amountIn,uint160 limitSqrtPrice) returns (uint256 amountOut,uint16 fee)",
  "function quoteExactOutputSingle(address tokenIn,address tokenOut,uint256 amountOut,uint160 limitSqrtPrice) returns (uint256 amountIn,uint16 fee)",
]);
// Algebra uses packed addresses ONLY; no Uniswap uint24 fee in path.
export const algebraRouterAbi = parseAbi([
  "function factory() view returns (address)",
  "function poolDeployer() view returns (address)",
  "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns(uint256 amountOut)",
]);
export const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
export const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
export const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
// Original v3-periphery SwapRouter: tuple enforces deadline on-chain.
export const routerAbi = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);
