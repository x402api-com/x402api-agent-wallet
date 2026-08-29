# x402api Agent Wallet

`x402api-agent-wallet` is a persistent local wallet and payment tool for agents
that purchase from x402 endpoints. It keeps private keys on the agent host,
uses separate wallets for each network, and durably binds every authorization
and submission to one exact merchant request.

The launch payer supports sponsored Base USDC and sponsored Solana USDC/USDT.
The buyer signs token authority only; x402api supplies ETH/SOL and pays the
canonical actual cost from its platform treasury. Actual gas is not debited
from the merchant tenant. A buyer does not need ETH or SOL. TRON wallet
management remains available, but TRON payment authorization is coming soon
and cannot be selected or used as a fallback.

> **Release status:** `0.2.5` is the current source and npm release line.
> Production mainnet support remains gated by the capped live evidence and
> release review described in [SECURITY.md](SECURITY.md).

## First-time wallet setup

The CLI can create its own high-entropy, owner-only unlock file. It never
prints the passphrase or changes a shell profile:

```bash
x402api wallet setup --json
x402api wallet list --json
```

`wallet setup` is idempotent. By default it writes a managed `0600` unlock
file under the private x402api data root and subsequent unlocking commands use
it automatically. `X402API_WALLET_PASSWORD_FILE` remains an explicit file-path
override, and `--password-stdin` remains available for an operator-supervised
command. The managed file makes a headless agent operable; it does not protect
the wallet from another process running as the same compromised OS user.

Create separate wallets for the exact networks an agent will use:

```bash
x402api wallet create --name agent-base --network eip155:8453 \
  --maximum-payment-atomic 25000000 --json
x402api wallet create --name agent-solana \
  --network solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp \
  --maximum-payment-atomic 25000000 --json
```

Use `wallet funding` with the exact live asset and target amount to calculate
the current deficit and return the payer address as both text and a QR payload:

```bash
x402api wallet funding --wallet agent-base \
  --asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --target-balance-atomic 25000000 --json
```

Transfer the named token to the returned payer wallet address, never to the
token contract/mint or merchant recipient. Supported Base and Solana payments
are sponsored, so the buyer does not fund ETH or SOL.

## Permissions and spend boundary

Use a dedicated wallet and fund it only with the amount the agent is allowed to
spend. A process that can unlock the wallet can spend its token balance. The
optional wallet-creation flag `--maximum-payment-atomic` adds a local
per-payment ceiling:

```bash
x402api wallet create \
  --name agent-base \
  --network eip155:8453 \
  --maximum-payment-atomic 1000000 \
  --json
```

The value is canonical atomic units for the supported payment asset. It is a
per-payment limit, not a daily or cumulative budget, merchant allowlist, or
hosted policy. Version 0.2.5 has no policy-update command; the ceiling is set
when the wallet is created. Owner-only directories (`0700`) and files (`0600`)
protect stored material from accidental local exposure, but they do not make a
compromised same-user host safe.

## Runtime and sponsored-fee boundary

The CLI runs on the buyer or agent host and keeps wallet keys there. It is not
hosted by or running inside WarpMetal. WarpMetal is a separate merchant and
reference integration that can hand an exact payment request to the local CLI.

For an admitted sponsored profile, x402api reserves and supplies the Base or
Solana native network fee from its platform treasury. The merchant tenant's
active allowance controls sponsorship admission, but actual gas is not a
tenant debit. The wallet enforces the exact gas-sponsorship declaration and
never falls back to buyer-funded ETH or SOL.

## Packages

- `@x402api/agent-wallet-core` — encrypted keystores, strict x402 contracts,
  supported-rail authorization, balances, and durable attempts.
- `@x402api/agent-wallet-cli` — the `x402api` command-line interface.
- `skills/x402api-pay` — portable instructions for Codex, Claude Code, and
  other skill-aware agents.

## Tenant installation

Tenants install the version-pinned CLI, then install the matching bundled skill
in their agent runtime. The skill is the operating and safety contract; the CLI
is the executable that holds keys, authorizes payments, and safely submits or
reconciles an exact credential-free request.

```bash
npm install --global @x402api/agent-wallet-cli@0.2.5
x402api skill install --output "$CODEX_HOME/skills/x402api-pay" --json
```

Use the skill directory required by your agent runtime when it is not Codex.
The install command never overwrites an existing directory.

For a credential-free paid endpoint, `x402api pay` performs durable
authorization and exact submission in one command. `payment authorize` and
`payment submit` keep the two stages explicit for merchant-specific tools.
Timeouts and asynchronous responses retain the same attempt and signature;
they never create a replacement payment automatically.

Merchant reconciliation metadata is outside the wallet contract. In
particular, `X-X402API-Challenge-Handle` is intentionally excluded from the
exact V1 request envelope; it is not the wallet-created buyer payment
identifier or a signing input.

For programmatic charges, the trusted merchant server—not the Agent Wallet—uses
the current resource `active_version.id` with `POST /v1/charges`. The wallet
receives only the resulting credential-free exact request and canonical
`PAYMENT-REQUIRED` challenge. See the
[merchant integration reference](skills/x402api-pay/references/merchant-integration.md).

## Refill notifications

`x402api wallet notify-refill` can ask the hosted x402api notification service
to email a subscription's verified human refill contact before a renewal. The
wallet signs the request; it does not send a private key, email address, tenant
name, or product label. x402api verifies the wallet/subscription relationship
and renders the email from canonical server-side tenant and product records.
See [the notification contract](docs/refill-notification-contract.md) and
[the hosted-server implementation plan](docs/server-refill-notification-implementation-plan.md).

The signed client command and contract ship in 0.2.2. The hosted endpoint is a
separate platform implementation and is not provided by this repository; do
not assume notification delivery is available unless an approved
`X402API_NOTIFICATION_URL` has been deployed and configured.

## Documentation

- [`llms.txt`](llms.txt) is the concise machine-readable documentation map.
- [CLI reference](skills/x402api-pay/references/cli-reference.md) lists the
  supported commands, environment, and error-routing contract.
- [Safety rules](skills/x402api-pay/references/safety.md) define funding,
  permissions, and secret-handling requirements.
- [Merchant integration](skills/x402api-pay/references/merchant-integration.md)
  defines exact request, artifact, retry, and reconciliation behavior.
- [Threat model](docs/threat-model.md) records trust boundaries and residual
  risks.
- [Source provenance](docs/source-provenance.md) records extracted code and the
  latest cross-repository synchronization audit.

## Development

Node.js 22 or newer is required.

```bash
npm ci
npm run check
```

Read [the implementation plan](docs/agent-wallet-cli-and-skill-plan.md),
[the threat model](docs/threat-model.md), [the refill notification contract](docs/refill-notification-contract.md),
[the hosted-server implementation plan](docs/server-refill-notification-implementation-plan.md),
and [SECURITY.md](SECURITY.md) before changing wallet, signing, attempt, or
artifact code.

## Wire compatibility

The launch path requires the deployed `com.x402api.gas-sponsorship` extension
and `com.x402api.x402.*-sponsored.v1` payload profiles. Lower-level historical
buyer-funded/TRON protocol modules remain available for conformance and labs,
but the public authorization workflow will not select them.

Licensed under the MIT License.
