---
name: x402api-pay
description: Use the x402api agent-wallet CLI to create, fund, inspect, back up, import, notify owners about, sweep, or retire persistent Base, Solana, and TRON wallets; authorize or submit exact x402 payments; handle 402 Payment Required responses; and resume or reconcile payment attempts. Use for initial purchases, renewals, low-balance refill requests, and any tenant workflow that pays an x402api merchant from a local agent wallet.
---

# x402api Pay

Use persistent, network-specific local wallets for exact x402 payments while
keeping keys, merchant credentials, and ambiguous payment attempts out of the
conversation.

## Establish the CLI contract

1. Run `command -v x402api` and `x402api help --json` before wallet work.
2. Require `--json` on every invocation and parse stdout as one JSON value.
3. Stop if the command is missing, its JSON contract is unsupported, or the
   requested network, asset, or payload profile is not exact.
4. Read [references/cli-reference.md](references/cli-reference.md) for commands,
   environment, result shapes, and stable errors.

Do not supply a passphrase on the command line. An operator must arrange
`X402API_WALLET_PASSWORD_FILE` as an owner-only file or supervise
`--password-stdin`. Never read, print, summarize, or paste that passphrase,
seed, private key, encrypted keystore, or complete payment signature.

## Choose or create the wallet

1. Determine the exact accepted network from the merchant challenge.
2. Run `x402api wallet list --json` and reuse a suitable persistent wallet.
3. Create one only if no suitable configured wallet exists. Never substitute
   an address from another network or create a new wallet merely because an
   order is a renewal.
4. Treat the funded balance as fully spendable by the autonomous agent, subject
   to any local per-payment ceiling.
5. Show the public address, exact network, supported asset, native fee currency,
   and requested funding amount when funding is insufficient. Never ask the
   owner to reveal or import a personal seed.

Keep Base, Solana, and TRON keys and addresses separate. Read
[references/safety.md](references/safety.md) before backup, import, sweep,
retirement, or any operation involving an unexpected challenge.

## Request a refill notification

Use `wallet notify-refill` when a registered subscription needs more asset
balance before a future purchase or renewal.

1. Use the authoritative x402api subscription reference from the purchase or
   renewal record.
2. Set the target asset balance and a canonical UTC `renew-by` deadline.
3. Let the CLI check the live balance. It returns `not_required` without
   contacting the notification service when the target is already met.
4. For a real deficit, let the wallet sign and send the short-lived request to
   the configured x402api notification service.
5. Report `accepted` or `deduplicated` using the returned notification ID.

Never accept or invent the email recipient, tenant display name, or product
label. x402api resolves those values from the verified refill contact and the
server-side subscription record, then sends the email as x402api. Do not retry
`notification_unavailable` in a tight loop; retain the deadline and use normal
backoff. If no authoritative subscription reference exists, show the funding
instructions to the human instead of sending email.

## Authorize an exact payment

1. Use the merchant-specific integration to prepare the authenticated business
   request and receive its `402 Payment Required` challenge.
2. Have that integration write the exact credential-free request envelope.
   Never place authorization tokens, cookies, SSH keys, or owner credentials in
   the envelope.
3. Verify the URL, method, exact body bytes, resource, network, asset, amount,
   recipient, profile, and challenge digest.
4. Check the chosen wallet's asset and native-fee/resource balances.
5. Invoke `payment authorize` once for that request envelope and preserve its
   returned attempt ID and owner-only artifact path.
6. Give the artifact path to the merchant-specific tool. Do not print or parse
   the complete payment signature into the conversation.

Read [references/merchant-integration.md](references/merchant-integration.md)
for the envelope, artifact handoff, notification-service boundary, and
submission rules.

## Resolve outcomes without double payment

Distinguish these states:

- funding: the wallet has usable asset and fee balance;
- authorization: one durable payment artifact exists;
- settlement: the payment is authoritative on the chosen rail;
- fulfillment: the merchant returned the purchased result.

On timeout, `202`, process restart, or conflicting evidence, look up the
existing attempt. Reuse its exact artifact and buyer payment identifier. Never
authorize the same request again merely because a submission result is
unknown. Use the merchant's authoritative status adapter to reconcile; local
abandonment does not revoke a signature or reverse settlement.

Stop on unsupported profiles, changed request bytes, corrupt artifacts,
expired challenges, unexpected recipients, or contradictory settlement data.
Do not work around these errors by changing networks, assets, wallets, or
merchant references.

## Respect release gates

The CLI may expose commands that deliberately return
`operation_not_supported`. Do not bypass this gate. In the initial release,
automatic sweep and full payer mode remain unavailable until their rail and
merchant conformance suites pass.
