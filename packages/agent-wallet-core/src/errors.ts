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
