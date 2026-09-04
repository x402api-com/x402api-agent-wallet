# Agent wallet threat model

## Assets

- network-specific private keys and encrypted backups;
- keystore passphrases and password files;
- exact signed transactions and `PAYMENT-SIGNATURE` artifacts;
- merchant credentials and exact request bytes;
- durable attempt state and release artifacts.

## Trust boundaries

- The owner chooses a dedicated wallet balance as the maximum economic
  exposure.
- An optional `maximumPaymentAtomic` value limits each payment only; it is not
  an aggregate, daily, merchant-specific, or revocation policy.
- The local host and any process allowed to invoke an unlocked CLI are trusted
  to spend that balance.
- Merchant responses, x402 challenges, RPC responses, skill prompts, and
  request-envelope files are untrusted.
- Refill notification requests are wallet-signed, but email recipients, tenant
  names, and product labels are trusted only when loaded from verified x402api
  subscription records.
- x402api hosted services never receive private keys or unlock material.
- The CLI runs on the buyer or agent host. Merchant integrations such as
  WarpMetal do not host the wallet process or become its key boundary.

## Required controls

- Separate keys and addresses for Base, Solana, and TRON.
- AES-256-GCM encrypted keystores with scrypt-derived keys and authenticated
  metadata.
- Owner-only directories and files; reject symlinks and unsafe permissions.
- Exact request, resource, asset, network, profile, amount, recipient, and
  challenge validation before signing.
- One durable artifact per request digest; ambiguous outcomes reuse it.
- Strictly reconcile payment IDs, settlement states and flags, transactions,
  and networks across `PAYMENT-RESPONSE`, recognized response bodies, the
  authorized attempt, and previously stored evidence.
- Treat confirmation as payment acceptance, block another ordinary submission,
  and allow only explicit exact reconciliation for pending merchant output.
- Store settlement evidence in an owner-only sidecar without changing the
  version-1 attempt record, so rollback does not make the base record unreadable.
- Never print secret keys or complete payment signatures in normal output.
- Explicit RPC endpoints and no network or asset fallback.
- Release provenance, dependency review, checksums, and private vulnerability
  reporting.
- Short-lived refill intent signatures bound to the exact endpoint audience;
  server-side subscription matching, deduplication, and rate limits.

## Residual risks

- A compromised or malicious host can use an unlocked wallet.
- An owner can fund the wrong network or unsupported asset.
- RPC providers can censor, delay, or lie; a single provider is not finality.
- A confirmed payment can still be reorged or reverted before finality. The CLI
  exposes nonretryable invalidation, but the merchant owns cancellation,
  compensation, delivered-resource recovery, and signed-receipt attachment.
- Lost passphrases or backups can permanently strand funds.
- Mainnet fee estimation and chain behavior can change after release.
- A compromised wallet can request nuisance refill emails; hosted delivery
  must rate limit and deduplicate without accepting arbitrary recipients.

## Out of scope for V1

Hosted custody, MPC, hardware wallets, smart-account delegation, automatic gas
or resource acquisition, replenishment, swaps, bridges, trading, arbitrary
signing, tenant-authenticated payment or receipt polling, merchant
compensation, and protection from a hostile host.
