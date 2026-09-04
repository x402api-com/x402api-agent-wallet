# `@x402api/agent-wallet-core`

Security-sensitive primitives for persistent local agent wallets. The package
owns encrypted keystores, strict x402 request contracts, sponsored Base and
Solana payment authorization, balances, exact paid-request submission, and
durable attempt and response-evidence records. TRON wallet/protocol primitives
remain available, but the launch authorization orchestrator rejects TRON.

Confirmed-first settlement evidence is decoded from the versioned
`com.k1hub.settlement-status` extension and compatible response bodies. The
core rejects contradictory payment IDs, states, flags, transactions, or
networks; stores public evidence in a backward-compatible private sidecar; and
separates initial submission from exact merchant-fulfillment reconciliation.

Use the `@x402api/agent-wallet-cli` package for the supported command-line
surface. This library deliberately exposes no arbitrary-signing API.

Local spend policy consists of the funded token balance and an optional
per-payment `maximumPaymentAtomic` ceiling. It does not provide aggregate,
daily, merchant-specific, or hosted-policy permissions.

The core also creates wallet-signed, subscription-scoped refill notification
requests. Email recipients and display content are resolved by x402api from
verified server-side tenant and product records.
