---
name: x402api-pay
description: Use the x402api agent-wallet CLI to create, fund, inspect, back up, import, notify owners about, sweep, or retire persistent wallets; authorize or submit sponsored Base USDC and Solana USDC/USDT x402 payments; handle 402 Payment Required responses; and safely resume or reconcile exact payment attempts. Use for initial purchases, renewals, low-balance refill requests, and any tenant workflow that pays an x402api merchant from a local agent wallet.
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

Install only the skill bundled with the exact CLI version. If it is not already
installed, an operator can run `x402api skill install --output PATH --json`.
The command refuses to overwrite an existing skill directory.

The `x402api` CLI runs on the buyer or agent host where its encrypted wallet is
stored. Merchant tools, including the WarpMetal reference integration, may
prepare requests and consume artifacts, but they do not host the CLI or receive
its private keys.

Do not supply a passphrase on the command line. On a fresh host, run `x402api
wallet setup --json`; the CLI creates and automatically uses a high-entropy,
owner-only managed unlock file without printing it or changing a shell profile.
An operator may instead arrange `X402API_WALLET_PASSWORD_FILE` as an owner-only
file or supervise `--password-stdin`. Never read, print, summarize, or paste
that passphrase, seed, private key, encrypted keystore, or complete payment
signature. The managed file is an automation boundary, not protection from a
compromised same-user host.

## Choose or create the wallet

1. Determine the exact accepted network from the merchant challenge.
2. Run `x402api wallet setup --json`, then `x402api wallet list --json`, and
   reuse a suitable persistent wallet. Repeated setup is safe and must not be
   replaced with hand-written password-file or shell-profile commands.
3. Create one only if no suitable configured wallet exists. Never substitute
   an address from another network or create a new wallet merely because an
   order is a renewal.
4. Treat the funded balance as fully spendable by the autonomous agent, subject
   to any local `maximumPaymentAtomic` per-payment ceiling. That ceiling is not
   a daily, cumulative, or merchant-specific permission.
5. Run the exact asset-aware `wallet funding` argv provided by the merchant
   workflow. Show its current, target, and deficit token amounts, public payer
   address, exact network, asset contract/mint, and QR payload when funding is
   insufficient. Never ask the owner to fund ETH/SOL, send to the token
   contract/merchant recipient, or reveal/import a personal seed.
6. For a one-off Base wallet balance or funding check, if the operator has not
   supplied a credential-free Base RPC, set `X402API_BASE_RPC_URL` to the
   official Base Mainnet endpoint `https://mainnet.base.org`. It is rate-limited
   and suitable for interactive setup checks, not sustained production traffic.

Keep Base, Solana, and TRON keys and addresses separate. TRON wallet management
does not mean TRON payment support: the launch payer must reject TRON as coming
soon. Read
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
   the envelope. Keep any merchant-side `X-X402API-Challenge-Handle` out as
   well; it is reconciliation metadata, not the buyer payment identifier or a
   signing input.
3. Verify the URL, method, exact body bytes, resource, network, asset, amount,
   recipient, profile, and challenge digest.
4. Require a launch-sponsored Base USDC or Solana USDC/USDT profile and the
   strict `com.x402api.gas-sponsorship` extension. Check the chosen wallet's
   token balance; never ask the buyer for ETH or SOL.
5. Invoke `payment authorize` once for that request envelope and preserve its
   returned attempt ID and owner-only artifact path.
6. Give the artifact path to the merchant-specific tool. Do not print or parse
   the complete payment signature into the conversation.
7. For a credential-free paid endpoint, use `payment submit` with the same
   attempt and request envelope, or use `pay` to authorize and submit in one
   invocation. The CLI stores the response privately and returns only evidence
   paths and public settlement metadata.

Read [references/merchant-integration.md](references/merchant-integration.md)
for the envelope, artifact handoff, notification-service boundary, and
submission rules.

## Resolve outcomes without double payment

Distinguish these states:

- funding: the wallet has usable USDC/USDT balance; x402api sponsors launch-rail
  ETH/SOL from its platform treasury, subject to the merchant tenant's active
  sponsorship allowance;
- authorization: one durable payment artifact exists;
- settlement: the payment is authoritative on the chosen rail;
- fulfillment: the merchant returned the purchased result.

On timeout, `202`, process restart, or conflicting evidence, look up the
existing attempt. Run `payment reconcile` with that attempt and the original
request envelope, or use the merchant's authoritative status adapter. Reuse
the exact artifact and buyer payment identifier. Never authorize the same
request again merely because a submission result is unknown. Local abandonment
does not revoke a signature or reverse settlement.

When `payment status` includes `lastPaymentId`, preserve it as the merchant's
durable reconciliation handle. It is public settlement metadata, not a new
authorization, and it never permits replacing the existing artifact.

Stop on unsupported profiles, changed request bytes, corrupt artifacts,
expired challenges, unexpected recipients, or contradictory settlement data.
Do not work around these errors by changing networks, assets, wallets, or
merchant references.
For sponsorship errors, never fall back to spending buyer ETH/SOL.

## Respect release gates

The CLI may expose commands that deliberately return
`operation_not_supported`. Do not bypass this gate. In the initial release,
automatic sweep and full payer mode remain unavailable until their rail and
merchant conformance suites pass.
