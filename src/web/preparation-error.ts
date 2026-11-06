// Fixed allowlisted copy only: never render untrusted RPC/provider error text.
import { preparationRpcMessages } from '../shared/fusion-preparation-rpc.js';
const messages: Readonly<Record<string,string>> = {
  ...preparationRpcMessages,
  FUSION_HEAD_FUTURE: 'Polygon head is more than 1 second ahead of the server clock. Preparation stopped.',
  FUSION_HEAD_STALE: 'Polygon head is more than 60 seconds old. Preparation stopped.',
  FUSION_HEAD_INVALID: 'Polygon head or server clock could not be validated. Preparation stopped.',
  FUSION_STATE_REORGANIZED: 'Polygon state changed during preparation. Preparation stopped.',
  FUSION_CHAIN_MISMATCH: 'The RPC is not Polygon mainnet. Preparation stopped.',
  FUSION_INPUT_BALANCE: 'Input token balance is insufficient. Preparation stopped.',
  FUSION_EXISTING_ALLOWANCE: 'An existing router allowance prevents zero-allowance preparation. No allowance was changed.',
  FUSION_CODE_MISSING: 'Required token or router code is missing. Preparation stopped.',
  FUSION_PREPARATION_RPC: 'Polygon preparation reads could not be validated. No automatic retry.',
  FUSION_PERMIT_PREFLIGHT: 'Token permit state is incompatible with safe preparation.',
};
export function preparationErrorMessage(code: string): string | null {
  return Object.hasOwn(messages,code) ? `${messages[code]} Recover saved status before starting again. Only a preparation with no requested signature can be discarded as unsigned. Any permit already signed remains valid independently until expiry.` : null;
}
