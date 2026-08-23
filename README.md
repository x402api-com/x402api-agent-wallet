# x402api Agent Wallet

`x402api-agent-wallet` is a persistent local wallet and payment tool for agents
that purchase from x402 endpoints. It keeps private keys on the agent host,
uses separate wallets for each network, and durably binds every authorization
and submission to one exact merchant request.

The launch payer supports sponsored Base USDC and sponsored Solana USDC/USDT.
The buyer signs token authority only; x402api supplies ETH/SOL and charges the
merchant tenant's prepaid service credit. A buyer does not need ETH or SOL.
TRON wallet management remains available, but TRON payment authorization is
coming soon and cannot be selected or used as a fallback.

Use a dedicated wallet and fund it only with the amount the agent is allowed to
spend. A process that can unlock the wallet can spend its token balance.

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
npm install --global @x402api/agent-wallet-cli@0.2.0
x402api skill install --output "$CODEX_HOME/skills/x402api-pay" --json
```

Use the skill directory required by your agent runtime when it is not Codex.
The install command never overwrites an existing directory.

For a credential-free paid endpoint, `x402api pay` performs durable
authorization and exact submission in one command. `payment authorize` and
`payment submit` keep the two stages explicit for merchant-specific tools.
Timeouts and asynchronous responses retain the same attempt and signature;
they never create a replacement payment automatically.

## Refill notifications

`x402api wallet notify-refill` can ask the hosted x402api notification service
to email a subscription's verified human refill contact before a renewal. The
wallet signs the request; it does not send a private key, email address, tenant
name, or product label. x402api verifies the wallet/subscription relationship
and renders the email from canonical server-side tenant and product records.
See [the notification contract](docs/refill-notification-contract.md) and
[the hosted-server implementation plan](docs/server-refill-notification-implementation-plan.md).

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
