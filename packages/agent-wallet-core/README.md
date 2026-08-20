# `@x402api/agent-wallet-core`

Security-sensitive primitives for persistent local agent wallets. The package
owns encrypted keystores, strict x402 request contracts, supported Base,
Solana, and TRON payment authorization, balances, and durable attempt records.

Use the `@x402api/agent-wallet-cli` package for the supported command-line
surface. This library deliberately exposes no arbitrary-signing API.

The core also creates wallet-signed, subscription-scoped refill notification
requests. Email recipients and display content are resolved by x402api from
verified server-side tenant and product records.
