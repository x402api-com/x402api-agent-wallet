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

Unlocking commands additionally require `X402API_WALLET_PASSWORD_FILE` or an
operator-supervised `--password-stdin`. Supported V1 networks are
`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, and
`tron:mainnet`.

## Refill notification

```text
x402api wallet notify-refill \
  --wallet NAME \
  --subscription-reference ID \
  --renew-by 2026-08-25T12:00:00.000Z \
  --target-balance-atomic N \
  --reason renewal \
  --json
```

`reason` is `renewal` or `low_balance`. The target is the desired supported
asset balance in atomic units, not the native fee balance. Results have status
`accepted`, `deduplicated`, or `not_required`. x402api chooses the pre-verified
email recipient and derives tenant and product display data from the
subscription; those values are intentionally not CLI arguments.

## Payment commands

```text
x402api payment authorize --wallet NAME --request-envelope FILE --artifact-out FILE --json
x402api payment status --attempt ID --json
x402api payment artifact --attempt ID --output FILE --json
x402api payment abandon --attempt ID --json
x402api payment reconcile --attempt ID --json
```

The authorization result includes the attempt ID, wallet, payer address,
network, asset, amount, artifact path, and `authorized` state. Ordinary output
does not include the full signature.

## Stable error routing

- `password_required`, `wallet_locked`: request operator unlock assistance;
  never request secret material in chat.
- `wallet_storage_unsafe`, `payment_artifact_corrupt`: stop and escalate.
- `insufficient_asset_balance`: show exact funding instructions or request a
  registered refill notification.
- `insufficient_network_fee_resources`: applies only to buyer-funded profiles;
  request the network's native fee asset/resource and do not swap automatically.
- `gas_treasury_below_floor`, `tenant_gas_credit_insufficient`,
  `sponsorship_reservation_expired`: the sponsored rail is temporarily not
  admissible; do not switch to buyer-funded gas.
- `sponsored_payload_invalid`, `sponsor_signature_unavailable`: stop and retain
  the attempt for safe retry or operator review.
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
