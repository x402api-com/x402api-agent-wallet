# x402api server refill-notification implementation plan

**Status:** Ready for hosted-platform implementation

**Client contract:** `docs/refill-notification-contract.md`

**Hosted boundary:** The x402api platform backend owns request verification,
subscription and product resolution, authoritative balance checks, verified
contact selection, durable notice creation, asynchronous email delivery, and
delivery evidence. The public agent-wallet repository never receives SMTP
credentials or human email addresses.

## 1. Outcome

Implement a public credential-free HTTPS endpoint that accepts the V1
wallet-signed refill envelope emitted by:

```text
x402api wallet notify-refill ... --json
```

When an authoritative subscription is underfunded, x402api emails its verified
human refill contact with the canonical tenant name, product/subscription,
wallet network and address, asset, required refill, and refill-by date. When
the wallet is already sufficiently funded, x402api records the authenticated
request but returns `not_required` without sending mail.

The endpoint does not replenish funds, hold keys, change subscriptions, or
allow callers to select email recipients or display text.

## 2. Reuse the existing notification platform

Use the hosted backend's existing notification boundary rather than a second
mail subsystem:

- verified `NotificationChannel` and `NotificationChannelVerification`
  records for refill-contact admission;
- `create_notice_request` and append-only `NotificationNoticeRequest` evidence;
- tenant runtime locks, tenant context, row-level security, composite tenant
  foreign keys, idempotency records, and audit events;
- the existing branded x402api email renderer and configured sender domain;
- asynchronous service-process delivery and explicit outcome recording; and
- existing delivery-receipt evidence where the delivery authority supports it.

Do not use the owner-login email implicitly. The subscription must point to an
active, verified email notification channel designated for wallet refills. The
delivery adapter resolves the channel ID to the verified destination through
the approved secret/delivery boundary; the request API and audit rows retain
only channel identifiers, masked labels, and destination digests.

## 3. Public endpoint

Add:

```text
POST /v1/agent-wallet/refill-notifications
Content-Type: application/json
```

This endpoint uses wallet-signature authentication, not tenant bearer
authentication. It must:

- require HTTPS at the edge and honor only the configured canonical public
  origin when reconstructing the audience;
- reject redirects, alternate hosts, ambiguous proxy headers, and non-JSON
  content types;
- cap the request body at 64 KiB before JSON parsing;
- accept only the exact top-level fields `version`, `intent`, and `signature`;
- reject duplicate JSON keys, floats, unsafe numbers, Unicode ambiguity, and
  unknown nested fields;
- parse atomic amounts as canonical decimal strings; and
- never log the raw signature or full request body.

Successful responses are always HTTP `202`:

```json
{
  "version": 1,
  "notificationId": "notification_...",
  "status": "accepted"
}
```

`status` is `accepted`, `deduplicated`, or `not_required`. Do not return the
email address or masked destination. Unknown, revoked, cross-tenant, or
unbound subscriptions use a single non-enumerating failure response.

## 4. Strict intent validation

Reproduce the TypeScript canonical JSON algorithm byte-for-byte and verify the
domain-separated message:

```text
x402api-agent-wallet-refill-v1\n<canonical intent JSON>
```

Validate:

- `version == 1` and `kind == "x402api.refill-notification.v1"`;
- `audience` exactly equals the configured endpoint URL after one canonical
  normalization pass;
- the subscription reference is 1-128 permitted identifier characters;
- network is exactly Base `eip155:8453`, Solana Mainnet, or `tron:mainnet`;
- address is canonical for that network;
- asset and symbol are the supported issuer-native asset for the network;
- all balance fields are canonical nonnegative decimals and the signed refill
  arithmetic is internally consistent;
- `renewBy`, `createdAt`, and `expiresAt` are canonical UTC timestamps;
- `createdAt` is within the configured clock-skew window, `expiresAt` is no
  more than 15 minutes after creation, and the request is unexpired; and
- nonce is canonical base64url with 192 bits of entropy.

Store the canonical intent digest and signature digest. Store the full signed
intent only if the security and retention review approves it; it contains no
secret, but minimization is preferred.

## 5. Network-specific signature verification

Dispatch only by the exact network/signature-scheme pair:

| Network | Required scheme | Verification |
| --- | --- | --- |
| Base | `eip191` | Recover the signer over the UTF-8 domain-separated message and compare its canonical EVM address to `intent.wallet.address`. |
| Solana | `ed25519` | Decode the canonical base58 public key, require a 32-byte key and 64-byte canonical base64 signature, and verify the exact UTF-8 message. |
| TRON | `tron-message-v2` | Apply TRON message-V2 recovery and compare the canonical Mainnet base58check address. |

Reject high-S/noncanonical signatures where the relevant ecosystem requires
it. Do not implement a generic signing endpoint. Reuse reviewed payment/address
primitives where possible and add public cross-language vectors generated by
the CLI for positive and negative cases.

## 6. Authoritative subscription binding

Add a resolver interface that maps the opaque subscription reference to one
immutable server-side binding:

```text
tenant
product or plan snapshot
renewal record and deadline
payer network and canonical wallet address
supported asset
authoritative target-balance policy
verified refill notification channel
merchant/integration source
binding state
```

The binding is created or updated only from authoritative purchase settlement
and subscription lifecycle events. Where available, bind it to the settled
payment order, buyer payment identifier, recovered payer, merchant reference,
and product snapshot. Never create a binding from a refill request.

The request is admissible only when:

- the binding is active and its tenant lifecycle permits notices;
- signed wallet network/address exactly matches the bound payer;
- asset matches the bound renewal rail;
- product and tenant display values come from current authoritative records;
- the renewal is pending within the configured notification window; and
- the refill channel is active, verified, and not expired or revoked.

Cross-tenant references and payer changes fail closed. A deliberate payer
rotation requires a versioned subscription-binding transition proven by a
settled purchase or an owner-authorized migration, never a field update from
this endpoint.

## 7. Independent balance and target calculation

Treat the signed balance fields as audit claims only. Before scheduling email:

1. Query the approved Mainnet RPC quorum or existing balance reader for the
   bound payer and exact asset.
2. Verify chain identity using Base chain ID, full Solana genesis hash, or full
   TRON genesis block ID.
3. Load the canonical upcoming charge from the subscription/product snapshot.
4. Compute the target balance from that charge plus any explicit server-side
   reserve policy. V1 should default to the exact upcoming charge with no
   hidden buffer.
5. Compute `refill = max(target - authoritative_balance, 0)`.
6. Compare signed and authoritative network, asset, deadline, and target.

If the authoritative balance meets the target, persist a suppressed request
and return `not_required`. If RPC evidence is unavailable or divergent, return
a retryable service failure and do not email. If the client's requested target
or deadline conflicts with subscription truth, reject it rather than silently
changing the message.

Native gas/resource balances may be included as a separate warning only when
read from authoritative RPC evidence. Never combine stablecoin and native-fee
amounts or tell the human that one substitutes for the other.

## 8. Persistence and idempotency

Add tenant-isolated persistence with database constraints, not application-only
checks.

### Subscription binding

`AgentWalletSubscriptionBinding` should contain the tenant, opaque public
reference/digest, source integration and source object ID, product snapshot
digest, network, payer, asset, verified notification channel, renewal policy,
state, and immutable creation evidence. Use explicit transitions for renewal,
payer rotation, suspension, and retirement.

### Refill request

`AgentWalletRefillRequest` should be append-only and contain the tenant,
binding, canonical intent digest, signature scheme/digest, authoritative fact
digest, reason, renewal deadline, target/refill amounts, deduplication key,
decision (`accepted`, `deduplicated`, `not_required`), request time, and source
IP/rate-limit bucket digests where policy permits.

Compute the deduplication key from a versioned canonical document containing:

```text
tenant ID, binding ID, network, canonical payer, asset,
renewal deadline, authoritative target, and reason
```

Exclude nonce, request time, client-observed balance, and signature so the same
economic notification deduplicates across agent retries. Enforce a unique
constraint for the active notification window.

### Delivery outbox

Create a transactional outbox row in the same transaction as the accepted
refill request and `NotificationNoticeRequest`. Workers claim rows with bounded
leases and idempotent provider keys. Never send email inside the HTTP request.
Persist attempts and terminal outcomes without overwriting immutable request
evidence.

## 9. Rate limits and abuse controls

Apply layered limits before costly RPC and email work:

- edge/IP request limit;
- invalid-signature budget per IP and recovered wallet;
- accepted request limit per wallet and subscription;
- delivery limit per tenant, verified channel, renewal, and UTC day; and
- a global emergency delivery circuit breaker.

Initial policy:

- one delivered email per binding, renewal deadline, target, and reason in 24
  hours;
- at most three wallet-refill emails per binding in seven days;
- at most ten wallet-refill emails per verified destination in 24 hours across
  tenants, with an operator-review path for legitimate multi-tenant owners;
- exponential backoff for provider failures; and
- no automatic retry after permanent recipient rejection or channel revocation.

Make limits configurable within bounded settings and emit metrics for every
drop, deduplication, suppression, and circuit-breaker action.

## 10. Email composition

Render text first, then the shared branded HTML shell. Use the configured
x402api sender with SPF, DKIM, and DMARC alignment. Subject example:

```text
[x402api] <Tenant display name>: refill <Product name> wallet by <date>
```

The body contains only server-derived values:

- tenant display name;
- product/subscription name and authoritative reference safe for display;
- renewal date and timezone-explicit deadline;
- exact network and asset;
- canonical public wallet address;
- authoritative current balance, target, and refill delta;
- separate native-fee/resource warning when applicable; and
- an HTTPS dashboard/deep link from trusted configuration.

Do not include private keys, signatures, bearer tokens, RPC URLs, raw intent
JSON, internal tenant IDs, or an agent-supplied tenant/product label. Escape all
display values in text and HTML. The dashboard link must not initiate a transfer
or encode an arbitrary destination.

## 11. Delivery and evidence

The worker:

1. reloads the binding, verified channel, and request under tenant context;
2. aborts if the channel or binding was revoked after enqueue;
3. renders from the immutable authoritative-facts snapshot;
4. submits with a provider idempotency key derived from the delivery row;
5. records provider acceptance separately from final delivery evidence;
6. admits a signed delivery receipt through the existing notification evidence
   boundary when available; and
7. emits an audit event without plaintext destination or message body.

Provider acceptance is not proof that the human read the email. Bounce and
complaint webhooks must authenticate the provider, update channel health, and
prevent repeated delivery to a permanently failing destination.

## 12. Error contract

Return stable machine codes without revealing whether a tenant, subscription,
wallet, or email exists:

| HTTP | Code | Retry |
| --- | --- | --- |
| 400 | `invalid_refill_request` | No; regenerate from current CLI contract. |
| 401 | `invalid_wallet_signature` | No; do not fall back to another network. |
| 404 | `refill_subscription_unavailable` | No; verify authoritative reference out of band. |
| 409 | `refill_binding_conflict` | No; reconcile payer/subscription state. |
| 429 | `refill_notification_rate_limited` | After bounded `Retry-After`. |
| 503 | `refill_evidence_unavailable` | Yes; bounded backoff with the same economic request. |

Do not distinguish missing, cross-tenant, revoked, or wrong-payer bindings in
public error detail. Successful deduplication is `202 deduplicated`, not `409`.

## 13. Observability and privacy

Metrics:

- accepted, deduplicated, not-required, rejected, rate-limited, and failed
  requests;
- signature failures by scheme without addresses as labels;
- RPC evidence latency/divergence by network;
- outbox age, provider acceptance, bounce, complaint, and final delivery;
- notifications per tenant/wallet/channel only in protected high-cardinality
  audit storage, not general metric labels.

Logs use notification ID, intent digest prefix, network, decision, and stable
error code. Do not log payer address unless the protected audit policy requires
it; otherwise log its keyed digest. Never log the destination, signature,
message body, product free text, or raw request.

Define retention and deletion rules for request metadata while preserving
financial/audit evidence required by policy. A tenant offboarding flow must
revoke bindings and channels, cancel pending outbox rows, and retain only the
minimum legally required digests.

## 14. Test plan

### Contract and signature tests

- consume frozen TypeScript vectors for Base, Solana, and TRON;
- verify canonical JSON parity and reject alternative encodings/duplicate keys;
- reject wrong audience, expiry, scheme/network pair, signer, address format,
  high-S/noncanonical signatures, and modified intent fields;
- test clock-skew boundaries and nonce entropy/encoding.

### Binding and tenant-isolation tests

- accept one exact settled payer/subscription binding;
- reject missing, cross-tenant, suspended, canceled, rotated, and wrong-asset
  bindings with non-enumerating responses;
- prove PostgreSQL RLS and composite foreign keys prevent cross-tenant reads
  and writes even when service code omits filters;
- prove a refill request cannot create or mutate a binding.

### Balance and decision tests

- independently verify Base, Solana, and TRON Mainnet identity;
- test below, equal, and above target balances;
- reject divergent/unavailable RPC evidence without sending email;
- reject client target/deadline conflicts;
- return `not_required` and create no outbox row when funded.

### Idempotency and concurrency tests

- concurrent equivalent requests create one refill request/notice/outbox;
- different nonces and signatures deduplicate to the same economic key;
- changed renewal or authoritative target creates a new key only when the
  binding permits it;
- worker lease expiry and restart never duplicate provider submission;
- provider retry uses the same provider idempotency key.

### Email and privacy tests

- tenant/product/address/amount/date come only from authoritative snapshots;
- client-supplied unknown display fields fail schema validation;
- text and HTML escape hostile tenant/product values;
- from-address and dashboard URL are trusted configuration;
- no raw email, signature, secret, or body appears in logs/audit payloads;
- revoked channels, bounces, complaints, and offboarding cancel delivery.

### Operational tests

- rate limits and circuit breaker under distributed concurrency;
- queue backlog and provider outage recovery;
- migrations on a production-sized dataset;
- capped end-to-end emails for one wallet on each supported rail;
- dashboard and support reconciliation by notification ID.

## 15. Delivery phases

### Phase A — Freeze contract and vectors

- Import the public V1 schema and canonicalization fixtures.
- Add the three signature verifiers behind unit-tested interfaces.
- Freeze endpoint URL, error codes, clock policy, and response contract.

**Exit:** all public positive and negative vectors pass in the hosted language.

### Phase B — Binding and persistence

- Add subscription binding, refill request, and outbox migrations.
- Add tenant RLS/composite constraints and immutable transition rules.
- Project settled purchase/subscription events into bindings.

**Exit:** a refill request can be proven against one authoritative binding and
cannot cross tenant boundaries.

### Phase C — Decision endpoint

- Implement strict request parsing, signature verification, binding lookup,
  authoritative RPC balance/renewal checks, deduplication, and rate limits.
- Return `accepted`, `deduplicated`, and `not_required` without sending email.

**Exit:** API/concurrency/security suites pass with email delivery disabled.

### Phase D — Email worker

- Integrate verified destination resolution, branded rendering, provider
  idempotency, outcome recording, bounce/complaint handling, and audit events.
- Add a tenant/operator feature flag and global kill switch.

**Exit:** sandbox delivery proves one email per rail with no duplicate under
worker restart.

### Phase E — Controlled rollout

- Enable internal/test tenants, then selected external tenants.
- Observe false-positive, deduplication, bounce, and provider-failure rates.
- Complete threat-model, privacy, incident-response, and runbook review.
- Enable production only after capped end-to-end evidence and rollback drill.

**Exit:** the hosted endpoint is stable, monitored, rate-limited, reversible,
and documented for tenant agents.

## 16. Definition of done

The server implementation is complete only when:

1. all three wallet signature schemes verify against shared public vectors;
2. every accepted request matches one authoritative tenant/subscription/payer
   binding and verified refill channel;
3. chain balance, target, product, tenant name, and renewal date are server
   derived;
4. sufficient balance returns `not_required` with no email outbox row;
5. retries and concurrency cannot create duplicate economic notifications;
6. email sends from x402api with canonical tenant/product/funding details;
7. no request can choose a recipient, tenant name, product label, or transfer
   destination;
8. RLS, audit, privacy, rate-limit, bounce, complaint, and offboarding tests
   pass;
9. dashboards and runbooks can reconcile by notification ID without exposing
   email or signature data; and
10. a feature flag and global kill switch can stop delivery without disabling
    payment authorization.
