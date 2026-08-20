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
