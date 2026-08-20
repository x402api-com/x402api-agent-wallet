# `@x402api/agent-wallet-cli`

Installs the `x402api` executable for persistent Base, Solana, and TRON agent
wallets and exact x402 payment artifacts.

The CLI is pre-release. Run `x402api help --json` for the machine-readable
command summary. Unlock material is accepted only from standard input or an
owner-only file named by `X402API_WALLET_PASSWORD_FILE`; passphrases are never
accepted as command-line values.

`wallet notify-refill` signs a short-lived refill intent and sends it to the
configured `X402API_NOTIFICATION_URL`. x402api resolves the verified refill
contact, tenant display name, and purchased product from the subscription
reference; the CLI never accepts an arbitrary recipient email or untrusted
tenant/product display text.
