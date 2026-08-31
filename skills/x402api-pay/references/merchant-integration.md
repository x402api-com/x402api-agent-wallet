# Merchant and notification integration

The merchant integration owns product selection and any separate business
authentication. The wallet owns keys, exact payment authorization, durable
attempt state, and optional submission of an exact credential-free paid
request. Do not put merchant credentials into the wallet envelope.

## Request envelope

The merchant tool writes an owner-only JSON file:

```json
{
  "version": 1,
  "method": "POST",
  "url": "https://merchant.example/v1/order",
  "contentType": "application/json",
  "bodyBase64": "eyJvcmRlcklkIjoib3JkZXJfMTIzIn0=",
  "paymentRequired": "<canonical PAYMENT-REQUIRED>",
  "challengeDigest": "sha256:<64 lowercase hex characters>",
  "merchantReference": "order_123"
}
```

The body is exact canonical base64 and is never parsed and reserialized before
paid submission. The decoded `resource.url` must equal the normalized envelope
URL. The envelope excludes authorization headers, cookies, API keys, SSH keys,
owner tokens, and merchant-side challenge handles. A response header such as
`X-X402API-Challenge-Handle` is opaque reconciliation metadata for the merchant
integration. It is not the buyer payment identifier, does not affect the token
authorization, and must not be added to this exact V1 envelope. The wallet
creates its own `buyerPaymentIdentifier` when it authorizes a selected payment
requirement.

## Programmatic charge handoff

A merchant may create a variable-price challenge with the tenant-authenticated
x402api `POST /v1/charges` endpoint before writing the wallet request envelope.
That operation belongs to trusted merchant server code—not this wallet.

- The merchant uses the current template `active_version.id` as
  `resource_version_id`; a resource UUID or `pay_...` public payment ID is not a
  substitute.
- One active template may allow multiple rails. The merchant charge supplies
  exact runtime amounts for a non-empty subset; the wallet independently
  validates and selects one returned `PAYMENT-REQUIRED.accepts` alternative.
- The request envelope receives only the exact credential-free protected
  request and canonical `PAYMENT-REQUIRED` challenge. It never contains the
  tenant API credential, `resource_version_id`, or a tenant-side API request.
- Retiring or replacing a template is a merchant concern. The wallet validates
  the exact issued challenge and must not discover, guess, or rewrite a
  template UUID.
- After authorization, trusted merchant code submits the exact artifact to
  `POST /v1/charges/{charge_id}/payments` with its tenant API credential. The
  wallet never receives that credential. The merchant should return the
  durable `payment_id` as `paymentId` so the wallet can retain it across `202`,
  `503`, process restart, and exact reconciliation.

See the tenant integration guide at
https://x402api.com/docs/payments/x402/programmatic-charges.

## Payment submission or artifact handoff

`payment authorize` writes an owner-only artifact once and records its digest
and attempt before returning. For a credential-free paid endpoint,
`payment submit` adds `PAYMENT-SIGNATURE` and sends the exact method, URL,
content type, and body. It disables redirects, bounds the response, and stores
the body and settlement evidence privately. `pay` combines these two steps.

When separate merchant credentials are required, a merchant-specific tool must
read the artifact locally and perform submission. Credentials must never be
placed in the request envelope or passed to the wallet CLI.

On timeout or an asynchronous response, run `payment reconcile` with the same
attempt and exact request envelope, or query merchant/facilitator status with
the buyer payment identifier. Reuse the artifact for a safe exact retry. Never
create a second authorization to resolve uncertainty. A settled attempt is
never downgraded by a later transport or replay failure.

## Hosted refill endpoint

The shipped CLI client posts a signed envelope to
`X402API_NOTIFICATION_URL`. This repository does not implement or deploy that
hosted endpoint. An approved server implementing the separate contract must be
available before a notification workflow is advertised. The signed intent
includes:

- a domain-separated V1 kind and exact endpoint audience;
- the subscription reference;
- wallet network and address;
- supported asset, observed balance, target balance, and refill delta;
- renewal deadline and `renewal` or `low_balance` reason;
- creation, expiration, and nonce fields.

Signatures are EIP-191 on Base, Ed25519 on Solana, and TRON message V2 on TRON.
The service response is strictly one of:

```json
{
  "version": 1,
  "notificationId": "notification_123",
  "status": "accepted"
}
```

`status` may also be `deduplicated` or `not_required`. Before email delivery,
x402api must verify the signature and expiration, match the payer wallet and
subscription, independently query the authoritative balance and target, load
the verified refill contact and canonical tenant/product records, apply rate
limits and deduplication, and render the email as x402api. A server result of
`not_required` means no email was queued. The service must reject client-sent
recipient addresses, tenant names, or product labels.
