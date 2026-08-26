# `@x402api/agent-wallet-cli`

Installs the `x402api` executable and bundled `x402api-pay` skill for persistent
agent wallets and exact x402 payments.

The launch payer authorizes only sponsored Base USDC and sponsored Solana
USDC/USDT. x402api supplies the network fee asset, so buyers do not need ETH or
SOL. TRON payment authorization returns `unsupported_profile` until that rail
is launched.

The CLI runs on the buyer or agent host; merchant integrations do not host it
or receive its keys. A wallet's funded token balance is spend authority, and
`wallet create --maximum-payment-atomic N` can add a per-payment ceiling. The
ceiling is not a daily, cumulative, or merchant-specific permission and cannot
be updated in place in version 0.2.2.

Run `x402api help --json` for the machine-readable command summary. Unlock
material is accepted only from standard input or an owner-only file named by
`X402API_WALLET_PASSWORD_FILE`; passphrases are never accepted as command-line
values. Paid response bodies and full payment signatures remain in owner-only
files and are not printed by ordinary JSON output.

Install the exact skill shipped with this CLI without overwriting an existing
copy:

```bash
x402api skill install --output "$CODEX_HOME/skills/x402api-pay" --json
```

`wallet notify-refill` signs a short-lived refill intent and sends it to the
configured `X402API_NOTIFICATION_URL`. x402api resolves the verified refill
contact, tenant display name, and purchased product from the subscription
reference; the CLI never accepts an arbitrary recipient email or untrusted
tenant/product display text.

The client contract is included in this package, but the hosted notification
endpoint is deployed separately and is not provided by the CLI package.
