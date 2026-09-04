export const ERROR_CODES = [
  "invalid_input",
  "wallet_not_found",
  "wallet_exists",
  "wallet_locked",
  "wallet_storage_unsafe",
  "password_required",
  "insufficient_asset_balance",
  "insufficient_network_fee_resources",
  "unsupported_network",
  "unsupported_asset",
  "unsupported_profile",
  "unsupported_payment_profile",
  "gas_sponsorship_unavailable",
  "gas_treasury_below_floor",
  "tenant_gas_credit_insufficient",
  "sponsorship_allowance_unavailable",
  "sponsorship_payment_cap_exceeded",
  "sponsorship_payment_allowance_exhausted",
  "sponsorship_volume_allowance_exhausted",
  "sponsorship_gas_budget_exhausted",
  "sponsorship_reservation_expired",
  "sponsored_payload_invalid",
  "sponsor_signature_unavailable",
  "settlement_outcome_unknown",
  "settlement_invalidated",
  "request_binding_mismatch",
  "payment_limit_exceeded",
  "attempt_already_exists",
  "attempt_not_found",
  "attempt_ambiguous",
  "challenge_expired",
  "rpc_not_configured",
  "rpc_unavailable",
  "notification_not_configured",
  "notification_unavailable",
  "payment_artifact_corrupt",
  "operator_confirmation_required",
  "operation_not_supported",
] as const;

export type AgentWalletErrorCode = (typeof ERROR_CODES)[number];

const EXIT_CODES: Record<AgentWalletErrorCode, number> = {
  invalid_input: 2,
  wallet_not_found: 10,
  wallet_exists: 11,
  wallet_locked: 12,
  wallet_storage_unsafe: 13,
  password_required: 14,
  insufficient_asset_balance: 20,
  insufficient_network_fee_resources: 21,
  unsupported_network: 30,
  unsupported_asset: 31,
  unsupported_profile: 32,
  unsupported_payment_profile: 35,
  gas_sponsorship_unavailable: 36,
  gas_treasury_below_floor: 37,
  tenant_gas_credit_insufficient: 38,
  sponsorship_allowance_unavailable: 45,
  sponsorship_payment_cap_exceeded: 46,
  sponsorship_payment_allowance_exhausted: 47,
  sponsorship_volume_allowance_exhausted: 48,
  sponsorship_gas_budget_exhausted: 49,
  sponsorship_reservation_expired: 44,
  sponsored_payload_invalid: 61,
  sponsor_signature_unavailable: 54,
  settlement_outcome_unknown: 55,
  settlement_invalidated: 56,
  request_binding_mismatch: 33,
  payment_limit_exceeded: 34,
  attempt_already_exists: 40,
  attempt_not_found: 41,
  attempt_ambiguous: 42,
  challenge_expired: 43,
  rpc_not_configured: 50,
  rpc_unavailable: 51,
  notification_not_configured: 52,
  notification_unavailable: 53,
  payment_artifact_corrupt: 60,
  operator_confirmation_required: 70,
  operation_not_supported: 71,
};

export class AgentWalletError extends Error {
  readonly code: AgentWalletErrorCode;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AgentWalletErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AgentWalletError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.exitCode = EXIT_CODES[code];
    if (options.details !== undefined) this.details = options.details;
  }
}

export function asAgentWalletError(error: unknown): AgentWalletError {
  if (error instanceof AgentWalletError) return error;
  return new AgentWalletError(
    "invalid_input",
    error instanceof Error ? error.message : "unexpected wallet error",
    { cause: error },
  );
}
