# Source provenance

The initial strict x402 header codec and Base, Solana, TRON, and external
recipient validators were extracted from the following private source owned by
the x402api project:

- Repository: `Fractal-Grid-AI/k1hub_402_payments`
- Commit: `8bf84404bc16d265d530c86071044f323a110316`
- Original packages: `@k1hub/x402-http` and `@k1hub/browser-wallet-sdk`
- Extraction date: 2026-08-19

Only environment-neutral buyer-side protocol code was selected. Managed-wallet
manifest code, hosted-service code, credentials, deployment configuration,
merchant authentication, and private operational fixtures were excluded.

The extracted files were adapted to local module imports, stripped of obsolete
browser-only checkpoint parameters, and placed under the repository's MIT
license by the project owner. Conformance tests must document any subsequent
behavioral change.

## Extraction inventory

| Private source | Public destination |
| --- | --- |
| `packages/typescript/x402-http/src/index.ts` | `packages/agent-wallet-core/src/protocol/http.ts` |
| `packages/typescript/browser-wallet-sdk/src/base.ts` | `packages/agent-wallet-core/src/protocol/base.ts` |
| `packages/typescript/browser-wallet-sdk/src/solana.ts` | `packages/agent-wallet-core/src/protocol/solana.ts` |
| `packages/typescript/browser-wallet-sdk/src/tron.ts` | `packages/agent-wallet-core/src/protocol/tron.ts` |
| `packages/typescript/browser-wallet-sdk/src/external-recipient.ts` | `packages/agent-wallet-core/src/protocol/external-recipient.ts` |
| x402 HTTP and browser-wallet SDK conformance tests | `packages/agent-wallet-core/tests/{http,base,solana,tron-provider-conformance}.test.ts` and reviewed fixtures |

Keystore, filesystem, balance, RPC-network identity, attempt, notification,
authorization orchestration, CLI, skill, packaging, and release code was
implemented in this public repository rather than copied from private hosted
services.

## Post-extraction synchronization

Last reviewed on 2026-09-04 against the deployed hosted-platform `main` at
`1decf2faa8ac2f84f42f598532428457735ee872`:

| Hosted or public change | Public agent-wallet result |
| --- | --- |
| Sponsored Base/Solana profiles and strict gas-sponsorship declaration | Implemented and tested in public [PR #7](https://github.com/x402api-com/x402api-agent-wallet/pull/7), then released with durable submission and reconciliation in [PR #8](https://github.com/x402api-com/x402api-agent-wallet/pull/8) / versions 0.2.0 through 0.2.2. |
| Hosted-platform commit `79b98ee` (`Add always-on sponsored gas payment rails`) | The buyer-side wire and signing behavior is represented by the public sponsored profiles and conformance tests. Hosted treasury, deployment, and merchant billing code remains private platform code and is intentionally not copied here. |
| Hosted-platform commit `dbd7f07` (`Fix dashboard permission selection`) | No port is required. It changes tenant-dashboard API-client and team-role form state only and does not touch any file in the extraction inventory or the local wallet permission model. |
| Hosted-platform OpenAPI 1.3.0 confirmed-first settlement contract | The public wallet strictly decodes `com.k1hub.settlement-status` version 1, accepts a successful HTTP 202 without treating merchant fulfillment as complete, persists public evidence separately from its version-1 attempt record, and exposes reorg/revert invalidation. Hosted chain watchers, tenant authentication, receipts, fulfillment, and compensation remain outside this repository. |

The public repository is canonical for agent-wallet behavior after extraction.
Future changes to mapped protocol files require an explicit compatibility and
conformance review; unrelated hosted UI, deployment, custody, or tenant-policy
changes must not be copied into this package.
