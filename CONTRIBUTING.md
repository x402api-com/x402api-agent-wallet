# Contributing

Changes to keystores, chain signing, request binding, attempt uniqueness, or
artifact formats require tests, a threat-model review, and compatibility notes.

Before opening a pull request:

```bash
npm ci
npm run check
```

Do not add arbitrary message signing, arbitrary transaction signing, token
swaps, automatic replenishment, or private merchant credentials to the wallet
boundary. New rails and payload profiles require exact public conformance
vectors and a versioned migration.

The refill notification is the sole narrow message-signing contract in V1. It
must remain domain-separated, endpoint-bound, expiring, subscription-scoped,
and free of client-selected email, tenant, or product display fields.
