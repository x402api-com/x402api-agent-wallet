# `@x402api/agent-wallet-cli`

Installs the `x402api` executable and bundled `x402api-pay` skill for persistent
agent wallets and exact x402 payments.

The launch payer authorizes only sponsored Base USDC and sponsored Solana
USDC/USDT. x402api supplies the network fee asset from its platform treasury,
so buyers do not need ETH or SOL and actual gas is not debited from the
merchant tenant. TRON payment authorization returns `unsupported_profile`
until that rail is launched.

The CLI runs on the buyer or agent host; merchant integrations do not host it
or receive its keys. A wallet's funded token balance is spend authority, and
`wallet create --maximum-payment-atomic N` can add a per-payment ceiling. The
ceiling is not a daily, cumulative, or merchant-specific permission and cannot
be updated in place in version 0.2.5.

Run `x402api wallet setup --json` once on a fresh host. It idempotently creates
a high-entropy managed unlock file under the private x402api data root; the
passphrase is never printed and no shell profile is changed. Unlock material
can instead come from supervised standard input or an owner-only file named by
`X402API_WALLET_PASSWORD_FILE`; passphrases are never accepted as command-line
values. A managed file and encrypted keystore on the same host do not protect
against a compromised same-user process. Paid response bodies and full payment
signatures remain in owner-only files and are not printed by ordinary JSON
output.

`wallet funding --wallet NAME --asset ASSET --target-balance-atomic N --json`
returns the exact token deficit and the payer address as both text and a QR
payload. Send only the named token on the exact network to that payer address,
not to the token contract/mint or merchant recipient. Supported Base/Solana
payments do not require buyer-funded ETH/SOL.

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
