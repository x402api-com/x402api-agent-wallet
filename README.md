# x402api Agent Wallet

`x402api-agent-wallet` is a persistent local wallet and payment tool for agents
that purchase from x402 endpoints. It keeps private keys on the agent host,
uses separate wallets for Base, Solana, and TRON, and emits owner-only payment
artifacts for exact merchant requests.

> **Status:** pre-release implementation. Do not fund wallets with more than
> you are prepared for the agent host to spend or lose. Mainnet use is blocked
> until the live release gates in the implementation plan are complete.

## Packages

- `@x402api/agent-wallet-core` — encrypted keystores, strict x402 contracts,
  supported-rail authorization, balances, and durable attempts.
- `@x402api/agent-wallet-cli` — the `x402api` command-line interface.
- `skills/x402api-pay` — portable instructions for Codex, Claude Code, and
  other skill-aware agents.

## Tenant installation

Tenants that want an agent to use x402api payments install both parts: the
version-pinned CLI on the agent host and the matching `skills/x402api-pay`
directory in that agent runtime's skill location. The skill is the operating
and safety contract; the CLI is the audited executable that holds keys and
authorizes payments. Installing only the CLI does not teach an agent the
funding, retry, refill-notification, or merchant-handoff workflow.

Published installation commands will be added after the npm scope and release
artifacts pass the gates in the implementation plan. During development, use
this repository checkout and do not install executable code from an unpinned
URL.

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

V1 uses the deployed `com.k1hub...` payload-profile and extension literals.
Those strings are signed wire identifiers, not package branding. They remain
exact until the facilitator, merchant integrations, fixtures, and public
documentation migrate together under a new version.

Licensed under the MIT License.
