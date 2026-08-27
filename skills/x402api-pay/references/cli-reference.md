# CLI reference

Every agent-driven invocation requires `--json`. Success writes one JSON value
to stdout and exits `0`. Failure writes one JSON error to stdout when `--json`
is present and uses a stable nonzero exit code.

## Environment

- `X402API_HOME`: optional local data root.
- `X402API_WALLET_PASSWORD_FILE`: owner-only, single-line passphrase file.
- `X402API_BASE_RPC_URL`: credential-free Base RPC URL.
- `X402API_SOLANA_RPC_URL`: credential-free Solana RPC URL.
- `X402API_TRON_RPC_URL`: credential-free TRON RPC URL.
- `X402API_NOTIFICATION_URL`: credential-free x402api refill endpoint.

RPC and notification URLs must use normalized HTTPS. HTTP is accepted only for
localhost development. Do not put bearer tokens or basic-auth credentials in
these URLs.

## Wallet commands

```text
x402api wallet create --name NAME --network NETWORK [--maximum-payment-atomic N] --json
x402api wallet list --json
x402api wallet show --wallet NAME --json
x402api wallet address --wallet NAME --json
x402api wallet balance --wallet NAME --json
x402api wallet backup --wallet NAME --output FILE --json
x402api wallet import --name NAME --input FILE --json
x402api wallet retire --wallet NAME --confirm NAME --json
x402api wallet sweep --wallet NAME --to ADDRESS --json
```

`--maximum-payment-atomic` is an optional canonical decimal in atomic units for
the wallet's supported payment asset. It is enforced on each authorization and
returns `payment_limit_exceeded` when the exact amount is larger. It is not a
daily or cumulative budget. Version 0.2.3 sets it only at wallet creation and
does not provide a policy-update command.

Unlocking commands additionally require `X402API_WALLET_PASSWORD_FILE` or an
operator-supervised `--password-stdin`. Supported V1 networks are
`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, and
`tron:mainnet`.

## Refill notification

```text
x402api wallet notify-refill \
  --wallet NAME \
  --subscription-reference ID \
  --renew-by RFC3339_UTC_DEADLINE \
  --target-balance-atomic N \
  --reason renewal \
  --json
```

`reason` is `renewal` or `low_balance`. The target is the desired supported
asset balance in atomic units, not the native fee balance. Results have status
`accepted`, `deduplicated`, or `not_required`. x402api chooses the pre-verified
email recipient and derives tenant and product display data from the
subscription; those values are intentionally not CLI arguments.

The client command is shipped, but this repository does not provide the hosted
notification endpoint. Configure `X402API_NOTIFICATION_URL` only for an
approved deployment of the server contract.

## Payment commands

```text
x402api payment authorize --wallet NAME --request-envelope FILE --artifact-out FILE --json
x402api payment submit --attempt ID --request-envelope FILE --json
x402api payment status --attempt ID --json
x402api payment artifact --attempt ID --output FILE --json
x402api payment abandon --attempt ID --json
x402api payment reconcile --attempt ID --request-envelope FILE --json
x402api pay --wallet NAME --request-envelope FILE --artifact-out FILE --json
```

The authorization result includes the attempt ID, wallet, payer address,
network, asset, amount, artifact path, and `authorized` state. Ordinary output
does not include the full signature. Submission sends only the exact
credential-free request from the envelope, disables redirects, and stores the
bounded response body and `PAYMENT-RESPONSE` evidence in owner-only files.
`pay` combines authorization and first submission; explicit commands are safer
when a merchant-specific integration owns the request lifecycle.

## Stable error routing

- `password_required`, `wallet_locked`: request operator unlock assistance;
  never request secret material in chat.
- `wallet_storage_unsafe`, `payment_artifact_corrupt`: stop and escalate.
- `payment_limit_exceeded`: the exact payment exceeds the wallet's local
  per-payment ceiling; do not split or reauthorize it to evade the limit.
- `insufficient_asset_balance`: show exact funding instructions or request a
  registered refill notification.
- `insufficient_network_fee_resources`: is not expected for a valid launch
  profile; stop because the merchant challenge was not safely sponsored.
- `gas_sponsorship_unavailable`, `gas_treasury_below_floor`,
  `sponsor_signature_unavailable`: retain the exact attempt and retry only with
  bounded backoff; never switch to buyer-funded gas.
- `sponsorship_allowance_unavailable`, `sponsorship_payment_cap_exceeded`,
  `sponsorship_payment_allowance_exhausted`,
  `sponsorship_volume_allowance_exhausted`,
  `sponsorship_gas_budget_exhausted`: the current authorization is terminal.
  The merchant tenant must top up or change its allowance configuration and
  issue a fresh challenge; the buyer must not fund native gas.
- `tenant_gas_credit_insufficient`: legacy-server response; retain the exact
  attempt and retry only after the merchant tenant restores service credit.
- `sponsorship_reservation_expired`: obtain a fresh challenge without reusing
  the expired authorization.
- `sponsored_payload_invalid`: stop; the challenge or signed payload is not
  safely sponsored.
- `settlement_outcome_unknown`: keep the exact attempt and request envelope;
  retry or reconcile them without creating a new authorization.
- `unsupported_network`, `unsupported_asset`, `unsupported_profile`,
  `request_binding_mismatch`: stop; never fall back.
- `attempt_already_exists`, `attempt_ambiguous`: reuse and reconcile the named
  attempt; do not reauthorize.
- `notification_not_configured`: ask the tenant operator to configure the
  x402api notification endpoint.
- `notification_unavailable`: retain the deadline and retry with bounded
  backoff; do not send repeated emails.
- `operator_confirmation_required`, `operation_not_supported`: require the
  documented human/release gate.
