# Refill notification contract

The wallet CLI can request an email when a registered x402api subscription
needs more supported-asset balance before a purchase or renewal. x402api sends
the email; the local wallet never receives SMTP credentials or the human's
email address.

## CLI method

```bash
x402api wallet notify-refill \
  --wallet codex-base \
  --subscription-reference subscription_123 \
  --renew-by "$RENEW_BY_UTC" \
  --target-balance-atomic 2000000 \
  --reason renewal \
  --json
```

Set `RENEW_BY_UTC` to the authoritative future renewal deadline in canonical
RFC 3339 UTC form.

The matching network RPC and `X402API_NOTIFICATION_URL` must be configured.
The command checks the live balance first. If the target is already met it
returns `not_required` and makes no notification request.

The client command and wire contract are shipped in 0.2.2. This repository does
not implement or deploy the hosted endpoint. Configure the URL only for an
approved x402api platform deployment that satisfies the requirements below.

## Signed request

For a deficit, the CLI signs a domain-separated canonical JSON intent that is
bound to:

- the exact normalized notification endpoint as its audience;
- the authoritative subscription reference;
- wallet network and public address;
- supported asset, current balance, target balance, and refill delta;
- canonical UTC renewal deadline and `renewal` or `low_balance` reason; and
- creation time, 15-minute expiration, and random nonce.

The full POST body is `{ "version": 1, "intent": ..., "signature": ... }`.
Base uses EIP-191, Solana uses Ed25519, and TRON uses message V2. Redirects are
rejected. The endpoint is credential-free HTTPS; localhost HTTP is allowed
only for development.

The response contains only `version`, a stable `notificationId`, and status
`accepted`, `deduplicated`, or `not_required`. The last status means the
server's authoritative balance and renewal check suppressed email delivery.

## Hosted-service requirements

Before sending mail, x402api must:

1. validate the strict request schema, endpoint audience, expiry, and network-
   appropriate signature;
2. recover or verify the payer address and match it to the subscription;
3. load the verified refill-contact email, canonical tenant display name,
   product/subscription description, and renewal record server-side;
4. independently query the supported-asset balance and recompute the target,
   refill delta, and renewal deadline from authoritative subscription policy;
5. compute an idempotency key that ignores the random nonce for an equivalent
   wallet, subscription, deadline, and target;
6. rate limit by tenant, subscription, wallet, and destination; and
7. render and send the email as x402api, including the exact network, asset,
   wallet address, requested refill, and refill-by date.

The service must reject any client-supplied email address, tenant display name,
or product label. A wallet signature authorizes only a notification request;
it does not authorize changing tenant contacts, subscription metadata, or
automatic replenishment.

Client-supplied balance and target fields are signed audit claims, not server
truth. A mismatch with authoritative chain or subscription data fails closed;
if the authoritative balance is already sufficient, the server records the
request and returns `not_required` without sending email.
