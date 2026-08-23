# x402api Agent Wallet CLI and Skill Plan

**Status:** 0.2.1 release candidate; registry publication remains release-gated

**Date:** 2026-08-19; launch amendment 2026-08-22

**Scope:** Open-source persistent agent wallet CLI, portable agent skill, and
merchant integration contract

**First reference merchant:** WarpMetal

**Launch payment rails:** sponsored Base USDC and sponsored Solana USDC/USDT

**Canonical repository:** `x402api-com/x402api-agent-wallet`

**Implementation baseline:** public agent-wallet protocol code extracted from
the private hosted-platform packages listed in `source-provenance.md`

## Launch amendment

This amendment supersedes conflicting rail, fee, profile, and signer-only
statements in the original phased design record below:

- The launch authorization orchestrator selects only sponsored Base USDC and
  sponsored Solana USDC/USDT requirements with the exact
  `com.x402api.gas-sponsorship` binding.
- x402api supplies ETH/SOL and charges the merchant tenant's prepaid gas
  billing. The buyer funds only the payment token and is never asked to fall
  back to buyer-funded gas.
- TRON wallet management and low-level conformance code remain available, but
  TRON payment authorization is coming soon and is rejected by the public
  payer.
- The CLI supports both explicit `payment authorize` / `payment submit` and a
  combined `pay` command for credential-free paid endpoints. Exact attempts,
  signatures, response bodies, and settlement evidence are durable.
- `payment reconcile` replays the exact request and signature. Ambiguous or
  settled states cannot be erased by a later transport error or replay 402.
- The matching `x402api-pay` skill is bundled in the CLI package and installed
  with `x402api skill install`; an existing skill directory is never
  overwritten.
- Public packages use only `@x402api/*`. Private `@k1hub/*` packages remain
  hosted-platform implementation dependencies and are not customer installs.

## 1. Executive decision

Build a reusable, open-source **x402api Agent Wallet CLI** and a separate
**x402api Agent Wallet Skill** in a dedicated public repository owned by the
`x402api-com` GitHub organization:

```text
x402api-com/x402api-agent-wallet
```

That repository is the canonical source for the wallet core, CLI, skill,
public contracts, releases, and security advisories. The private
`Fractal-Grid-AI/k1hub_402_payments` repository is the implementation baseline
and hosted-platform integration source; it is not the release repository for
this product. This draft may be prepared here, but its canonical copy and all
implementation work move to `x402api-com/x402api-agent-wallet` before Phase 1.

The product model is intentionally simple:

```text
Agent creates a persistent local wallet for a supported network
    -> owner funds its public address with the exact supported asset
    -> agent uses the funded balance for autonomous x402 purchases
    -> owner monitors, tops up, sweeps, or retires the wallet
```

Each network wallet is persistent across purchases, agent sessions, and
merchant integrations. It is not a disposable per-purchase wallet. Its funded
balance is the primary economic boundary: an operator should assume an
autonomous agent can spend each configured wallet's entire available balance.

A named agent setup may contain separate Base, Solana, and TRON wallets. V1
uses separate keys and addresses per network rather than deriving or reusing a
key across incompatible ecosystems. An owner only needs to create and fund the
rails that agent will use.

x402api remains non-custodial:

- x402api servers never receive agent private keys, recovery material, or
  signing sessions;
- the CLI creates and uses keys locally on the agent host;
- the skill contains instructions only and never implements cryptography;
- merchants receive only a valid `PAYMENT-SIGNATURE` and public payer data;
- the owner's primary wallet key is never given to the agent; and
- no hosted balance, omnibus wallet, delegation service, or policy service is
  required for V1.

WarpMetal is the first reference integration, not the owner of the wallet
implementation. Any x402api tenant or x402-compatible resource can reuse the
same CLI and skill.

## 2. Why this belongs in x402api

The current x402api implementation already contains the reusable buyer-side
protocol primitives:

- `@k1hub/x402-http` strictly decodes and encodes x402 v2 headers;
- `@k1hub/browser-wallet-sdk` constructs and validates hosted checkout
  payments; and
- the platform defines the exact payload profiles accepted by its facilitator.

The public agent-wallet repository must not depend at runtime on the private
platform monorepo or on unpublished `@k1hub` packages. V1 extracts the minimum
reviewed HTTP, validation, and supported-rail authorization primitives needed
by `@x402api/agent-wallet-core`, together with their conformance tests. The
extraction must preserve provenance and must pass license, secret, dependency,
and private-data review before any source is published. It must not copy
hosted-service code, private configuration, merchant credentials, or internal
operational fixtures.

After extraction, the public implementation and conformance vectors become
canonical for agent-wallet behavior. The hosted platform and merchant
integrations consume released public artifacts where appropriate or run
compatibility tests against them; they must not maintain an untracked second
implementation of the signing and retry contracts.

The new CLI supplies the missing headless wallet boundary for autonomous
agents. The skill makes that boundary usable by Codex, Claude Code, and other
tool-using agents without copying wallet instructions into every merchant.

Merchant repositories should not independently implement key generation,
keystore formats, chain signing, x402 payload construction, or ambiguous retry
handling. Doing so would create incompatible wallets and duplicate the most
security-sensitive code.

This is a buyer-side open-source product. It does not change the hosted
External-Wallet V1 promise that x402api does not custody tenant funds or keys.

## 3. Product boundaries

### 3.1 x402api Agent Wallet CLI owns

- local wallet creation and import;
- local encrypted keystore access;
- public address and balance inspection;
- supported-chain RPC access;
- strict `PAYMENT-REQUIRED` validation;
- exact supported-profile payment construction and signing;
- buyer payment identifier creation;
- durable local payment-attempt records;
- safe reuse of the same `PAYMENT-SIGNATURE` after ambiguous outcomes;
- machine-readable status and stable exit codes;
- explicit sweep and wallet retirement workflows; and
- redaction of keys and signed payment artifacts from ordinary output.

### 3.2 x402api Agent Wallet Skill owns

- instructions for installing and invoking the CLI;
- the wallet funding and balance-check workflow;
- the autonomous x402 payment state machine;
- rules for interpreting CLI JSON and exit codes;
- retry and reconciliation guidance;
- safety constraints for prompts, logs, and files; and
- handoff guidance for merchant-specific skills.

The skill must not contain signing code, accept secrets, reinterpret payment
amounts, or tell a model to implement missing cryptography itself.

### 3.3 Merchant integrations own

- product discovery and selection;
- authenticated business requests;
- canonical request method, URL, content type, and body;
- merchant credentials that are unrelated to wallet signing;
- product-specific limits or operator instructions;
- submission of the exact paid request when using signer-only mode;
- fulfillment, entitlement, provisioning, and merchant reconciliation; and
- their own agent skill or CLI for the product workflow.

### 3.4 Owners own

- funding the agent wallet from a wallet they already control;
- deciding the operating balance;
- backing up the encrypted agent keystore when desired;
- protecting and recovering the host;
- monitoring wallet activity;
- sweeping remaining funds; and
- accepting that compromise of an unlocked autonomous agent host can expose
  the funded balance.

### 3.5 Explicit V1 non-goals

- Hosted x402api custody of agent wallets or funds.
- Access to the owner's primary wallet private key.
- Fiat onramp, token swaps, bridges, or automatic balance replenishment.
- Buyer-side gas acquisition, swaps, or automatic wallet replenishment.
- Smart-account delegation, MPC, HSM, or third-party wallet integrations.
- A hosted policy engine or approval service.
- Arbitrary message signing, arbitrary transaction signing, trading, or token
  transfers from model-provided calldata.
- Hiding the fact that an autonomous agent can spend its wallet balance.
- Solving hostile-host security. A compromised agent host is a compromised hot
  wallet.

## 4. User experience

### 4.1 First-time setup

```text
1. Install the x402api CLI and agent skill.
2. Ask the agent to create a persistent wallet for each network it will use.
3. The CLI creates each local keystore and returns only its public address.
4. The agent displays each address, exact network, exact accepted token, and
   current balances without treating addresses from different networks as
   interchangeable.
5. The owner transfers a chosen operating budget from an existing wallet.
6. The agent verifies the on-chain balance.
7. Each funded wallet remains available for future purchases and renewals on
   its network.
```

No payment is attempted during wallet creation. The user must see and verify
the network and public address before funding.

### 4.2 Autonomous purchase

```text
1. Merchant tool prepares the exact unpaid request.
2. Merchant returns 402 + PAYMENT-REQUIRED.
3. Agent passes a canonical, non-secret request envelope to the x402api CLI.
4. CLI validates the challenge and checks wallet balances.
5. CLI constructs and signs exactly one payment attempt.
6. CLI persists the attempt before the paid request can be submitted.
7. Merchant tool or CLI submits the exact request with PAYMENT-SIGNATURE.
8. A 202, timeout, or transport ambiguity reuses the same request and signature.
9. Final payment and fulfillment state are reported separately.
```

There is no human approval per purchase in the default autonomous workflow.
The owner limits exposure by funding the dedicated wallet appropriately.

### 4.3 Ongoing operation

- The agent checks the wallet balance before beginning a purchase.
- Insufficient token, native-fee, or network-resource availability produces a
  stable, non-destructive error.
- The owner can top up the same public address at any time.
- The wallet may pay different x402api merchants and may renew earlier
  purchases.
- The owner can sweep and retire the wallet when it is no longer needed.

## 5. Target architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Agent host                                                          │
│                                                                     │
│  Codex / Claude Code                                                │
│          │                                                          │
│          ├── Merchant skill and CLI                                 │
│          │      product selection · private merchant auth · request │
│          │                                                          │
│          └── x402api skill                                          │
│                 │                                                   │
│                 v                                                   │
│          x402api Agent Wallet CLI                                   │
│          validation · attempt store · RPC · signing                 │
│                 │                                                   │
│          local encrypted keystore                                   │
└─────────────────┬───────────────────────────────────────────────────┘
                  │ PAYMENT-SIGNATURE / signed buyer transaction
                  v
         Merchant x402 endpoint
                  │
                  v
         x402api facilitator and settlement
                  │
                  v
         Merchant receiving wallet
```

The model may invoke the CLI but does not need the raw private key. This
protects the key from accidental prompt and log exposure; it does not pretend
that an agent allowed to call the unlocked CLI lacks spending authority.

## 6. Repository and package layout

Implement in the dedicated public repository
`x402api-com/x402api-agent-wallet`. Do not add the implementation to
`Fractal-Grid-AI/k1hub_402_payments`, and do not place it in
`x402api-com/x402api-typescript`; that repository is the generated public API
SDK rather than the source for a security-sensitive wallet product.

```text
x402api-agent-wallet/
  packages/agent-wallet-core/
    src/
    tests/
    README.md
    package.json

  packages/agent-wallet-cli/
    src/
    tests/
    README.md
    package.json

  skills/x402api-pay/
    SKILL.md
    agents/openai.yaml
    references/cli-reference.md
    references/safety.md
    references/merchant-integration.md

  fixtures/conformance/
  examples/merchant-integration/
  .github/CODEOWNERS
  .github/dependabot.yml
  .github/workflows/ci.yml
  docs/agent-wallet-cli-and-skill-plan.md
  README.md
  SECURITY.md
  CONTRIBUTING.md
  LICENSE
  package.json
```

The root is a Node.js workspace for the two TypeScript packages and for
repository-level build, typecheck, test, pack-smoke, provenance, and release
checks. Generic merchant fixtures and conformance vectors may be public;
WarpMetal implementation code and credentials remain in the WarpMetal
repository.

Public artifacts:

| Artifact | Name | Purpose |
| --- | --- | --- |
| Core library | `@x402api/agent-wallet-core` | Keystore, RPC, attempts, and supported-profile authorization |
| CLI package | `@x402api/agent-wallet-cli` | Installs the `x402api` executable |
| Skill | `x402api-pay` | Portable instructions for tool-using agents |

All public packages use the `@x402api` namespace. Phase 0 must verify npm scope
ownership, organization publisher access, provenance configuration, and name
availability. If that access is unavailable, release is blocked; packages must
not silently fall back to `@k1hub` while the product and documentation promise
`x402api` ownership.

The core library prevents the CLI from becoming the only integration surface.
Trusted merchant tools can later call the same code in-process without
spawning a process or reimplementing signing.

### 6.1 Repository bootstrap and source extraction

Bootstrap the new repository with a clean public history instead of moving the
private monorepo or exposing its Git history:

1. Create `x402api-com/x402api-agent-wallet` as a public repository with
   `main` as its protected default branch.
2. Add this plan as the canonical planning document, then add `README.md`,
   `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, dependency update policy,
   secret scanning, and CI. Add `LICENSE` only after the license is approved.
3. Record the reviewed source commit from
   `Fractal-Grid-AI/k1hub_402_payments` and identify the exact files and tests
   eligible for extraction.
4. Extract only the minimum buyer-side protocol code required by
   `agent-wallet-core`; rename public imports and package metadata to
   `@x402api` and retain any required notices or attribution.
5. Run secret, private-data, dependency-license, provenance, and generated-file
   scans before the first public push containing extracted code.
6. Prove behavior with deterministic conformance vectors rather than relying
   on private platform fixtures.
7. After parity is proven, make the public packages the reusable source for
   compatible buyer-side behavior and keep cross-repository compatibility tests
   pinned to released contract versions.

The plan file in `k1hub_402_payments` is a staging copy until step 2. Do not
commit parallel canonical copies that can drift; once the new repository
exists, this location should contain only a link or migration note if an
internal reference remains useful.

## 7. CLI contract

### 7.1 General rules

- Binary name: `x402api`.
- All agent-facing commands support `--json`.
- JSON stdout contains one documented object and no prose.
- Diagnostics go to stderr and never include keys or full payment signatures.
- Secret or signed artifacts are written to owner-only files, not printed by
  default.
- Commands are non-interactive when `--json` is supplied unless a command is
  explicitly documented as requiring local operator input.
- Every error has a stable `code`, human-readable `message`, `retryable`
  boolean, and process exit code.
- Unknown fields in request, challenge, keystore, and attempt documents fail
  closed unless explicitly versioned as extensions.

### 7.2 Wallet commands

```bash
x402api wallet create --name codex-base --network eip155:8453 --json
x402api wallet create --name codex-solana --network solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp --json
x402api wallet create --name codex-tron --network tron:mainnet --json
x402api wallet list --json
x402api wallet show --wallet codex-base --json
x402api wallet address --wallet codex-base --json
x402api wallet balance --wallet codex-base --json
x402api wallet notify-refill --wallet codex-base \
  --subscription-reference <id> \
  --renew-by <canonical-UTC-timestamp> \
  --target-balance-atomic <amount> \
  --reason <renewal-or-low_balance> \
  --json
x402api wallet backup --wallet codex-base --output <encrypted-file> --json
x402api wallet import --name codex-base --input <encrypted-file> --json
x402api wallet sweep --wallet codex-base --to <owner-address> --json
x402api wallet retire --wallet codex-base --confirm codex-base --json
```

V1 does not provide `export-private-key`, `sign-message`, `sign-typed-data`,
`send-transaction`, or an arbitrary token-transfer command. `sweep` is a
purpose-specific lifecycle operation with an explicit destination, complete
balance preview, and separate confirmation contract.

`wallet create` returns public information only:

```json
{
  "version": 1,
  "wallet": "codex-base",
  "network": "eip155:8453",
  "address": "0x...",
  "storage": "local-encrypted-keystore",
  "status": "created_unfunded"
}
```

### 7.3 Payment commands

Support two integration modes.

#### Signer-only mode

The merchant tool retains control of its authenticated HTTP request. It gives
the wallet CLI a canonical request envelope without unrelated bearer tokens.

```bash
x402api payment authorize \
  --wallet codex-base \
  --request-envelope <request.json> \
  --artifact-out <payment-artifact.json> \
  --json
```

The output identifies the durable attempt and artifact path, but does not print
the complete signature by default:

```json
{
  "version": 1,
  "attemptId": "...",
  "wallet": "codex-base",
  "payerAddress": "0x...",
  "network": "eip155:8453",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amountAtomic": "12000000",
  "artifactPath": "/absolute/path/payment-artifact.json",
  "state": "authorized"
}
```

The merchant tool reads the owner-only artifact, extracts the encoded
`PAYMENT-SIGNATURE`, and submits the exact paid request. WarpMetal uses this
mode because it must retain its owner token and exact task request.

#### Full payer mode

For public or self-contained x402 endpoints, the CLI may own the entire HTTP
exchange:

```bash
x402api pay --wallet codex-base --request <request.json> --wait --json
```

This mode performs the unpaid request, validates the challenge, authorizes one
attempt, submits the paid request, and safely waits or retries. It must not
accept bearer tokens directly in command-line arguments. Sensitive headers,
when unavoidable, come from an owner-only request file or a merchant adapter
and are redacted from attempt records.

Signer-only mode is the required V1 integration path. Full payer mode can ship
after the signer and retry contracts are proven with WarpMetal.

### 7.4 Attempt commands

```bash
x402api payment status --attempt <id> --json
x402api payment artifact --attempt <id> --output <path> --json
x402api payment reconcile --attempt <id> --json
x402api payment abandon --attempt <id> --json
```

`abandon` changes local workflow state only. It cannot reverse an on-chain
authorization or settlement and must say so explicitly.

## 8. Versioned request and artifact contracts

### 8.1 Request envelope

The request envelope binds the payment challenge to exact request bytes while
excluding merchant credentials that are not part of payment authorization:

```json
{
  "version": 1,
  "method": "POST",
  "url": "https://api.warpmetal.com/api/checkout/agent",
  "contentType": "application/json",
  "bodyBase64": "eyJ0YXNrSWQiOiJ0YXNrXy4uLiJ9",
  "paymentRequired": "<encoded PAYMENT-REQUIRED>",
  "challengeDigest": "sha256:<64 lowercase hex characters>",
  "merchantReference": "task_..."
}
```

Rules:

- `method`, normalized URL, content type, and exact body bytes are mandatory;
- the decoded x402 resource must match the request;
- `challengeDigest` is mandatory, canonical lowercase SHA-256, and is passed
  unchanged into profiles that commit to the server challenge;
- headers unrelated to x402 request binding are omitted;
- authorization tokens, cookies, SSH keys, and merchant owner tokens are
  prohibited;
- body bytes are never parsed and reserialized before paid submission;
- `merchantReference` is opaque and non-authoritative; and
- a canonical SHA-256 digest identifies the envelope.

### 8.2 Payment artifact

The owner-only artifact is the handoff between the wallet and merchant tools:

```json
{
  "version": 1,
  "attemptId": "...",
  "requestDigest": "sha256:...",
  "buyerPaymentIdentifier": "...",
  "wallet": "codex-base",
  "payerAddress": "0x...",
  "selectedRequirementDigest": "sha256:...",
  "paymentSignature": "<encoded PAYMENT-SIGNATURE>",
  "createdAt": "...",
  "expiresAt": "..."
}
```

The artifact is written atomically with owner-only permissions. Ordinary CLI
output and logs contain its path and digest, not its full contents.

### 8.3 Local attempt record

Persist before returning an authorized artifact:

```json
{
  "version": 1,
  "attemptId": "...",
  "requestDigest": "sha256:...",
  "challengeDigest": "sha256:...",
  "selectedRequirementDigest": "sha256:...",
  "buyerPaymentIdentifier": "...",
  "paymentArtifactDigest": "sha256:...",
  "state": "authorized",
  "createdAt": "...",
  "updatedAt": "..."
}
```

The attempt store must survive process and agent-session restarts. It is the
authority that prevents an agent from creating a second payment after a
timeout or `202`.

## 9. Wallet storage and lifecycle

### 9.1 Storage decision

Use a storage-provider interface. V1 should implement a local encrypted
keystore backed by platform credential storage where available:

- macOS Keychain;
- Windows Credential Manager/DPAPI; and
- Linux Secret Service for supported desktop environments.

Headless Linux needs an explicit supported unlock design before it is called
fully autonomous. Acceptable designs include a locally supervised signer
process with an operator-unlocked encrypted keystore or a documented external
secret-store adapter. Do not silently fall back to an unencrypted key file.

The plan protects keys from accidental prompt, stdout, logs, crash reports,
and repository exposure. Because the agent is deliberately authorized to use
the wallet, local storage does not create a hard security boundary against a
fully compromised same-user host.

### 9.2 Filesystem rules

- Resolve an explicit application data directory per operating system.
- Never store wallets or attempts inside the current repository by default.
- Create files and directories with owner-only permissions.
- Use atomic write-and-rename with fsync where durability matters.
- Reject symlinks and unsafe ownership or permission changes.
- Never accept a keystore passphrase or private key through CLI arguments.
- Redact application data paths when they reveal unnecessary user information
  in telemetry or support bundles.

### 9.3 Backup and recovery

- `wallet backup` exports only an encrypted, versioned keystore bundle.
- Import verifies the bundle before replacing or creating any wallet record.
- Import never overwrites an existing wallet without an explicit, verified
  destination name.
- The CLI verifies the derived public address after import.
- Documentation warns that losing both local storage and backup can make
  remaining funds unrecoverable.

### 9.4 Sweep and retirement

- Sweep previews token amount, native-fee requirement, destination, and
  resulting expected balance.
- V1 sweep may be deferred until native-fee handling is finalized, but the
  storage format and CLI namespace reserve it now.
- Retirement is prohibited while a payment attempt is non-terminal or balances
  are nonzero unless the owner uses a separate explicit force workflow.
- Retiring a wallet does not erase audit records needed to reconcile payments.

### 9.5 Refill notification

`wallet notify-refill` checks the live supported-asset balance and does nothing
when the requested target is already met. For a deficit, it creates a
short-lived domain-separated signature over the exact x402api notification
endpoint, subscription reference, payer network/address, asset, observed and
target balances, refill delta, renewal deadline, reason, expiration, and
nonce. Base uses EIP-191, Solana uses Ed25519, and TRON uses message V2.

The x402api notification service verifies the signature and subscription-to-
wallet relationship, then resolves the verified human refill contact, tenant
display name, and purchased product from server-side records. The CLI never
accepts an arbitrary email address, tenant name, or product label. The service
sends as x402api, independently verifies the authoritative balance and target,
and must deduplicate equivalent requests, rate limit delivery, and return a
stable notification ID. A sufficiently funded wallet returns `not_required`
without email delivery even if the client reported a deficit. This is a
communication workflow, not automatic replenishment or custody. The hosted
work is specified in
[`server-refill-notification-implementation-plan.md`](server-refill-notification-implementation-plan.md).

## 10. Payment state and retry invariants

Use a small local state machine:

```text
prepared
  -> authorized
  -> submitting
  -> pending
  -> settled
  -> fulfilled

prepared/authorized/submitting/pending
  -> terminal_failed
  -> abandoned_local
```

Required invariants:

1. One request envelope digest has at most one live buyer payment identifier.
2. One attempt persists exactly one `PAYMENT-SIGNATURE` artifact.
3. `202`, `payment_pending`, `payment_finalizing`, timeout, connection reset,
   or an unknown transport outcome never creates a replacement signature.
4. A retry uses the exact method, URL, content type, body bytes, and
   `PAYMENT-SIGNATURE`.
5. A changed or expired challenge requires a new attempt only after the prior
   attempt has a definitive nonpayment outcome or explicit reconciliation.
6. Broadcast is not settlement, and settlement is not merchant fulfillment.
7. CLI restart or model context loss does not lose the attempt state.
8. Concurrent commands for the same request digest serialize through a local
   lock and durable uniqueness constraint.

These rules must be implemented in deterministic code, not left to skill prose.

## 11. Production launch rail implementation

The public payer supports these exact sponsored launch rails:

| Rail | Network | Exact asset | Runtime profile |
| --- | --- | --- | --- |
| Base USDC | `eip155:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `com.x402api.x402.base-usdc-eip3009-sponsored.v1` |
| Solana USDC | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `com.x402api.x402.solana-sponsored.v1` |
| Solana USDT | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `com.x402api.x402.solana-sponsored.v1` |

The `com.x402api...` values are signed wire identifiers. The CLI compares
literal advertised profiles and does not alias names or fall back to dormant
buyer-funded/TRON profiles.

### 11.1 Common requirements

- Reuse strict header and challenge decoding from `x402-http`.
- Reuse or extract environment-neutral construction and validation from
  `browser-wallet-sdk` rather than implementing second versions of the three
  admitted payment profiles.
- Keep separate wallet keys, addresses, balances, RPC configuration, and
  payment artifacts for each network.
- Validate network, exact issuer-native asset, recipient, amount, challenge
  binding, expiration, recovered payer, and canonical signature before
  producing a payment artifact.
- Use the same request-envelope, attempt, artifact, retry, JSON, and error
  contracts across all rails.
- Keep RPC endpoints explicit and configurable, with safe defaults documented
  separately from protocol truth.
- Never silently fall back from one rail, asset, or payload profile to another.

### 11.2 Base USDC adapter

- Generate and store a secp256k1 key for the Base wallet.
- Derive and display the checksummed EVM address beginning with `0x`.
- Construct the exact EIP-3009 authorization required by the challenge.
- Support the admitted profile's already-signed transaction path where
  appropriate.
- Validate chain ID, EIP-712 domain and message, USDC contract, transaction
  fields, recovered signer, and canonical low-s signatures.
- Report USDC and ETH balances separately.

### 11.3 Solana USDC/USDT adapter

- Generate and store an ed25519 keypair for the Solana wallet.
- Derive and display the base58 Solana public address without an EVM prefix.
- Derive the wallet's associated token account for the exact USDT mint and
  report whether it exists before funding or payment.
- Reuse the existing static version-0 transaction builder: compute-unit limit,
  compute-unit price, one `TransferChecked`, and the exact challenge memo.
- Fetch a recent blockhash from a configured trusted Solana RPC endpoint.
- Sign the exact frozen message locally and reject any change in message,
  account order, mint, token program, memo, amount, fee payer, or signature
  vector.
- Report USDT token-account balance and SOL balance separately.

### 11.4 TRON USDT adapter (coming soon)

- Generate and store a secp256k1 key dedicated to the TRON wallet.
- Derive and display the Mainnet base58check address beginning with `T`.
- Reuse the existing deterministic TRC-20 transaction builder for the exact
  issuer-native USDT contract.
- Freeze and validate owner, recipient, amount, challenge commitment,
  timestamp, expiration, fee limit, network identity, and protobuf transaction
  bytes before and after local signing.
- Reject Shasta, Nile, wrong contracts, changed transaction bytes, or an
  unexpected recovered signer.
- Report USDT and TRX/resource availability separately.

### 11.5 Sponsored fee handling

Launch challenges bind each requirement to a short-lived gas-sponsorship
reservation. The payer verifies that binding and its expiry before RPC or
signing. x402api supplies ETH/SOL; the buyer needs only the stablecoin. A
sponsorship failure returns a stable error and never triggers buyer-funded gas,
bridging, swapping, or another rail.

## 12. Agent skill design

The skill is portable documentation packaged for agent runtimes. It should be
small enough to audit and should point to focused references rather than
embedding implementation details in one large prompt.

Create it with the standard skill initializer when Phase 3 begins. Keep
`SKILL.md` concise, imperative, and below 500 lines. Put detailed CLI schemas
and merchant variants in directly linked, one-level-deep references. Do not add
a skill README, installation guide, changelog, or duplicate reference material.

The skill name is `x402api-pay`: it is short, tool-namespaced, and describes
the action the agent performs rather than only the wallet object it manages.

### 12.1 `SKILL.md` responsibilities

- Include YAML frontmatter containing only `name` and `description`.
- Make `description` the complete trigger contract. It should cover creating,
  funding, inspecting, backing up, sweeping, or retiring an x402api agent
  wallet; authorizing or submitting an x402 payment; handling a merchant's
  `402 Payment Required`; and resuming or reconciling an existing attempt.
- Identify when an x402 payment is required.
- Require installation/status checks before payment work.
- Use `--json` for every agent-driven CLI invocation.
- Create one persistent wallet for the selected network only when no suitable
  configured wallet exists; never substitute an address from another network.
- Show the public address and ask the owner to fund it when insufficient.
- Never ask for or read the owner's wallet seed or private key.
- Never print, summarize, or paste the local agent wallet key.
- Treat wallet balance as fully spendable by the autonomous agent.
- Use merchant-specific tooling to prepare authenticated business requests.
- Call `payment authorize` once for a request envelope.
- Reuse attempt artifacts for ambiguous outcomes.
- Distinguish wallet funding, authorization, settlement, and fulfillment.
- Stop on unsupported profiles, changed requests, corrupted attempts, or
  conflicting payment evidence.

### 12.2 Skill references

`references/cli-reference.md`:

- commands, JSON shapes, exit codes, and examples.

`references/safety.md`:

- dedicated-wallet funding model;
- key/logging restrictions;
- hostile prompt and malicious merchant considerations;
- compromised-host and lost-backup limitations; and
- sweep/retirement precautions.

`references/merchant-integration.md`:

- generic merchant handoff;
- signer-only versus full payer mode;
- request envelope and artifact contracts;
- exact retry requirements; and
- guidance for composing merchant and x402api skills.

### 12.3 Skill distribution

- Keep the canonical skill in `x402api-com/x402api-agent-wallet` next to the
  CLI release.
- State the minimum and maximum compatible CLI contract versions in the skill
  body or a directly linked reference, not as extra YAML frontmatter.
- Generate `agents/openai.yaml` from the completed skill with deterministic
  display name, short description, and default prompt values.
- Include its files in release artifacts and document installation for Codex,
  Claude Code, and generic skill loaders.
- Run automated checks that examples reference real commands and current JSON
  fields.
- Run the standard skill `quick_validate.py` check before packaging.
- Forward-test the installed skill in clean agent sessions against wallet
  creation, insufficient funding, successful payment, ambiguous retry, and
  merchant-composition scenarios without leaking expected answers.
- Never make the skill download executable code from an unpinned URL at payment
  time.

## 13. Generic merchant integration contract

Every merchant integration should follow the same boundary:

```text
Merchant skill/tool
  1. selects product
  2. prepares exact authenticated request
  3. obtains 402 challenge
  4. writes non-secret request envelope

x402api CLI
  5. validates and authorizes one payment
  6. writes owner-only payment artifact

Merchant skill/tool
  7. submits exact request with artifact
  8. reuses exact artifact while outcome is ambiguous
  9. reports fulfillment
```

Merchant integrations must:

- depend on the versioned envelope and artifact contracts, not CLI prose;
- retain merchant bearer tokens and product credentials outside the wallet
  artifact;
- avoid passing secrets in process arguments;
- preserve exact request bytes;
- accept an existing attempt after process restart;
- not ask the CLI for a second payment merely because fulfillment is pending;
- verify the final response and receipt through the merchant's authoritative
  API; and
- document which x402api profiles they accept.

The merchant can use the CLI process boundary first and migrate to
`agent-wallet-core` in-process later without changing the payment contract.

## 14. WarpMetal reference integration

WarpMetal already separates order preparation, payment challenge, paid
submission, and asynchronous waiting. Preserve that design. WarpMetal changes
are made and released from its own repository; the public agent-wallet
repository contains only the generic merchant contract, sanitized fixtures,
and cross-repository conformance expectations.

### 14.1 Required WarpMetal changes

Add a safe export command or option that writes a versioned x402api request
envelope from its stored exact checkout state:

```bash
warpmetal checkout challenge \
  --task <task-id> \
  --payment-request-out <request.json> \
  --json
```

The envelope includes:

- exact checkout method and URL;
- exact content type and body bytes;
- the live `PAYMENT-REQUIRED` value; and
- the task ID as an opaque merchant reference.

It must not include the WarpMetal owner token, SSH private key, or any wallet
secret.

Continue using the existing paid submission boundary:

```bash
warpmetal checkout submit \
  --task <task-id> \
  --payment-signature-file <artifact-or-derived-header-file> \
  --wait \
  --json
```

Prefer teaching WarpMetal to read the versioned x402api payment artifact
directly, for example with a future `--payment-artifact` option, so integrations
do not manually extract headers. Preserve `--payment-signature-file` for
compatibility.

### 14.2 WarpMetal skill changes

Replace disposable per-purchase wallet instructions with:

- choose among the accepted live rails using configured wallet balances and
  exact challenge requirements;
- use an existing configured x402api agent wallet for that network when
  available;
- create one persistent wallet per selected network only during initial setup;
- show its public address when funding is required;
- call the x402api skill/CLI for the wallet and payment stages;
- never create a new wallet for a renewal merely because it is a new order;
- reuse the exact payment artifact during `payment_pending` and
  `payment_finalizing`; and
- keep WarpMetal owner-token recovery and SSH control separate from payment
  wallet ownership.

### 14.3 End-to-end WarpMetal flow

```bash
# One-time setup for each rail the agent will use
x402api wallet create --name codex-base --network eip155:8453 --json
x402api wallet create --name codex-solana \
  --network solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp --json
x402api wallet create --name codex-tron --network tron:mainnet --json

# Owner funds one or more displayed addresses, then the agent verifies them
x402api wallet balance --wallet codex-base --json
x402api wallet balance --wallet codex-solana --json
x402api wallet balance --wallet codex-tron --json

# Existing WarpMetal order preparation occurs here
warpmetal checkout challenge \
  --task task_123 \
  --payment-request-out request.json \
  --json

# One durable authorization
x402api payment authorize \
  --wallet <wallet-for-the-selected-live-rail> \
  --request-envelope request.json \
  --artifact-out payment.json \
  --json

# Exact submission and retry through WarpMetal
warpmetal checkout submit \
  --task task_123 \
  --payment-artifact payment.json \
  --wait \
  --json
```

The exact command names are proposed contracts and may change only before the
first public CLI release. Once published, incompatible changes require a new
contract version and migration guidance.

## 15. Security model

### 15.1 Assets to protect

- local agent wallet private key;
- encrypted backup material;
- signed raw transactions and `PAYMENT-SIGNATURE` artifacts;
- merchant bearer tokens and private order state;
- local attempt integrity; and
- software supply chain and release artifacts.

### 15.2 Trust statement

The owner deliberately gives the autonomous agent authority to spend the
dedicated wallet. V1 does not claim to prevent an authorized agent from
spending its funded balance. It aims to prevent:

- exposure of the owner's primary wallet;
- accidental leakage of the agent key into model context or logs;
- signing unsupported or malformed x402 payloads;
- duplicate payments after ambiguous outcomes;
- accidental cross-network or wrong-token payment;
- merchant tools silently changing exact request bytes; and
- x402api servers becoming a custody boundary.
- unverified agents selecting arbitrary refill-email recipients or spoofing
  tenant and product display data.

### 15.3 Minimum safeguards

- No generic signing or transaction API.
- Strict supported-profile allowlist.
- Optional owner-configured maximum per x402 payment, enforced locally before
  signing. The funded balance remains the hard practical budget.
- Exact request/challenge/recipient/amount binding.
- Atomic attempt persistence and locking.
- Owner-only artifact permissions and log redaction.
- Dependency pinning, reproducible package artifacts, and release provenance.
- Security disclosure process and threat-model documentation.
- Wallet-signed, expiring refill intents whose recipients and display content
  are resolved from verified x402api subscription records.
- Clear warnings that host compromise can drain the agent wallet.

Merchant allowlists, daily counters, smart-account permissions, and hosted
policy services may be added later, but they are not prerequisites for the
direct funded-wallet V1.

## 16. Error model

Define stable error codes before the skill is published. Minimum set:

| Code | Meaning | Retry guidance |
| --- | --- | --- |
| `wallet_not_found` | Requested wallet does not exist | Create or choose wallet |
| `wallet_locked` | Keystore cannot be used | Restore local unlock boundary |
| `wallet_storage_unsafe` | Ownership, permission, or symlink check failed | Human repair required |
| `insufficient_asset_balance` | Stablecoin balance is too low | Owner funds wallet |
| `insufficient_network_fee_resources` | Native fee balance or network resources are too low | Owner funds fee asset/resources; automation deferred |
| `unsupported_network` | Challenge network is not supported | Do not sign |
| `unsupported_asset` | Challenge asset is not supported | Do not sign |
| `unsupported_profile` | Advertised payload profile is not implemented | Do not sign |
| `request_binding_mismatch` | Challenge does not match request envelope | Re-fetch through merchant tool |
| `payment_limit_exceeded` | Optional local per-payment cap exceeded | Owner changes funding/config intentionally |
| `attempt_already_exists` | Request already has a live attempt | Reuse existing attempt |
| `attempt_ambiguous` | Payment may have been submitted | Reconcile or reuse exact artifact |
| `challenge_expired` | Challenge is no longer valid | Reconcile old attempt before replacement |
| `rpc_unavailable` | Trusted RPC cannot provide required evidence | Retry without creating a new attempt |
| `notification_not_configured` | Hosted refill endpoint is not configured safely | Tenant operator configures it |
| `notification_unavailable` | x402api could not accept a refill request | Retry with bounded backoff; do not spam |
| `payment_artifact_corrupt` | Artifact digest or schema failed | Stop and investigate |

The skill must branch on codes, not match free-form English messages.

## 17. Testing and verification

### 17.1 Core unit tests

- deterministic secp256k1 and ed25519 key generation through injected test
  entropy;
- keystore encrypt/decrypt/import/address derivation;
- unsafe filesystem and symlink rejection;
- strict request-envelope schema and canonical digest;
- strict challenge selection and resource binding;
- Base EIP-3009 and transaction conformance vectors;
- Solana version-0 message, associated token account, challenge memo, and
  ed25519 signature conformance vectors;
- TRON deterministic protobuf transaction, challenge commitment, address, and
  secp256k1 signature conformance vectors;
- recovered signer and exact payer address;
- attempt uniqueness, locking, crash recovery, and artifact integrity;
- log and JSON redaction; and
- stable error and exit-code mapping.
- refill-intent signature, audience, expiry, deficit, response-schema,
  deduplication, and secret-free display-data boundaries.

Never use deterministic production entropy; deterministic generation exists
only behind test injection.

### 17.2 CLI integration tests

- install from a packed tarball into a clean temporary consumer;
- create, list, show, backup, import, and retire Base, Solana, and TRON test
  wallets;
- fund against Base, Solana, and TRON fixtures;
- authorize a supported 402 challenge on each V1 rail;
- refuse wrong chain, asset, recipient, amount, profile, body, and URL;
- restart between authorization and submission;
- issue concurrent authorization commands for the same envelope;
- preserve one artifact across `202`, timeout, and connection reset;
- distinguish settlement from fulfillment; and
- prove stdout never contains a private key or unrequested payment signature.
- prove refill notification is skipped at target balance and otherwise sends
  only a wallet-signed subscription reference to the configured x402api
  endpoint.

### 17.3 Skill tests

- validate skill structure, YAML frontmatter, naming, `agents/openai.yaml`, and
  referenced files with the standard skill validator;
- lint every command against CLI help/schema snapshots;
- simulate funded and unfunded wallet flows;
- simulate unsupported challenge and corrupt-attempt flows;
- verify the agent never requests an owner seed or private key;
- verify ambiguous outcomes reuse the existing attempt; and
- test composition with a mock merchant skill and the WarpMetal skill.

### 17.4 WarpMetal conformance

- new purchase on Base USDC, Solana USDT, and TRON USDT;
- second purchase with the same network-specific wallet;
- renewal with the same network-specific wallet;
- renewal using a different accepted rail when intentionally selected;
- insufficient balance followed by owner top-up and resume;
- `payment_pending` and `payment_finalizing` across process restart;
- changed/expired challenge after definitive failure;
- owner token absent from the x402api request envelope and attempt store; and
- exact server fulfillment and receipt reconciliation.

### 17.5 Live release evidence

Before GA:

- capped production payments on Base USDC, Solana USDT, and TRON USDT;
- payments to at least two independent x402api merchants;
- one WarpMetal purchase and renewal on each rail;
- one ambiguous-response recovery without duplicate settlement;
- clean-install proof on supported macOS and Linux environments;
- encrypted backup/restore proof; and
- package tarball, checksum, provenance, dependency, and vulnerability review.

## 18. Delivery phases

### Phase 0 — Contract and threat model

- Approve this plan.
- Create `x402api-com/x402api-agent-wallet`, make this plan canonical there,
  and configure protected `main`, ownership, security reporting, secret
  scanning, dependency updates, and required CI.
- Approve the open-source license and review the exact private-source files,
  tests, commit provenance, notices, and dependency licenses eligible for
  extraction before publishing code.
- Freeze V1 trust statement and non-goals.
- Verify `@x402api` npm scope publisher access, reserve the two package names,
  and configure trusted publishing and provenance. Do not fall back to
  `@k1hub`.
- Resolve `com.k1hub...` versus `com.x402api...` payload profile identities and
  update runtime and public contracts together.
- Freeze request-envelope, artifact, attempt, error, and JSON contracts.
- Decide supported local storage/unlock environments.
- Write a focused threat model and security review checklist.

**Exit:** the public repository is ready for reviewed source, package ownership
is verified, the extraction inventory is approved, and schemas and trust
boundaries are reviewed before wallet code exists.

### Phase 1 — Agent wallet core

- Create `packages/agent-wallet-core` in the public repository.
- Implement separate Base, Solana, and TRON wallet creation with encrypted
  storage.
- Implement network-correct address derivation and separate token/native or
  resource balance reads.
- Extract the approved minimum Base, Solana, and TRON x402 construction and
  validation code, rename its public surface to `@x402api`, retain required
  provenance, and prove parity with sanitized conformance vectors.
- Implement attempt store, locks, artifacts, and recovery.
- Add deterministic offline conformance tests for all three rails.

**Exit:** library tests can create and fund each wallet on a fixture, authorize
one exact payment per rail, restart, and recover each identical artifact.

### Phase 2 — CLI

- Create `packages/agent-wallet-cli` and the `x402api` binary in the public
  repository.
- Implement wallet lifecycle commands for all three V1 networks.
- Implement signer-only `payment authorize` and attempt inspection.
- Freeze JSON and exit-code contracts.
- Extend workspace build, typecheck, test, and pack-smoke scripts.
- Add README, security, backup, and recovery documentation.

**Exit:** a clean tarball install completes the signer-only flow without any
private key or full payment signature appearing in ordinary stdout/logs.

### Phase 3 — Agent skill

- Initialize `x402api-pay` with the standard skill initializer.
- Create the concise canonical skill, `agents/openai.yaml`, and focused
  references.
- Add CLI compatibility guidance and validation tests.
- Test with Codex and at least one other agent runtime.
- Forward-test realistic workflows in clean agent sessions.
- Publish install and update instructions.

**Exit:** an agent can create a wallet, request funding, check balance, and
authorize a mock purchase using only the skill and CLI contracts.

### Phase 4 — WarpMetal reference integration

- Add request-envelope export in the WarpMetal repository.
- Add payment-artifact input there while retaining signature-file
  compatibility.
- Update the WarpMetal skill and machine-readable documentation in the same
  WarpMetal release.
- Remove disposable per-purchase wallet guidance.
- Pin WarpMetal conformance tests to a released agent-wallet CLI contract
  version; keep only sanitized merchant fixtures in the public agent-wallet
  repository.
- Test initial purchase, repeat purchase, renewal, top-up, restart, and pending
  settlement on Base USDC, Solana USDT, and TRON USDT.

**Exit:** WarpMetal is purchased and renewed autonomously from persistent
network-specific wallets without exposing its owner token to wallet artifacts.

### Phase 5 — Generic payer and ecosystem release

- Add full payer mode for public/self-contained x402 endpoints.
- Publish a merchant integration guide and reference fixture.
- Test a second independent merchant integration.
- Implement and roll out the hosted refill endpoint according to
  [`server-refill-notification-implementation-plan.md`](server-refill-notification-implementation-plan.md).
- Publish packages, skill, checksums, provenance, and compatibility matrix from
  `x402api-com/x402api-agent-wallet` only.
- Update x402api public docs and `/llms.txt` without changing hosted custody
  claims.

**Exit:** an independent x402api tenant can integrate without WarpMetal code.

### Phase 6 — Fee handling and optional adapters

- Evaluate native-fee assistance and resource handling separately per rail.
- Evaluate additional networks or assets only with exact conformance and live
  evidence.
- Evaluate external wallet adapters, smart-account delegation, hardware/KMS,
  gas assistance, and replenishment as independent features.

**Exit:** each added adapter preserves the same request, artifact, attempt, and
skill contracts or introduces an explicitly versioned migration.

## 19. V1 acceptance criteria

V1 is complete only when all of the following are true:

1. `x402api-com/x402api-agent-wallet` is the public canonical source for the
   reviewed implementation, skill, contracts, releases, and security policy.
2. Its released packages and installed CLI have no runtime dependency on the
   private platform monorepo or unpublished `@k1hub` packages.
3. A supported agent can install the CLI and skill from public, pinned release
   artifacts.
4. The agent can create separate persistent Base, Solana, and TRON wallets and
   receives only their network-correct public addresses in normal output.
5. An owner can fund any of those addresses from an existing wallet using the
   exact supported asset and network.
6. The CLI reports USDC/ETH, Solana USDT/SOL, and TRON USDT/TRX or resource
   status separately.
7. Each wallet authorizes its admitted x402api payment profile using reviewed,
   provenance-recorded protocol primitives and public conformance vectors.
8. Private keys never leave the local storage provider or appear in prompts,
   command arguments, stdout, logs, payment artifacts, or merchant requests.
9. A payment attempt and artifact survive process restart.
10. Timeout and `202` paths reuse the exact signature and cannot create a second
   live attempt for the same request.
11. WarpMetal completes initial purchases and renewals using persistent wallets
   on all three rails.
12. A second merchant can reuse the same CLI and skill without depending on
    WarpMetal.
13. An underfunded registered subscription can request an idempotent refill
    email sent by x402api to its verified human contact, using canonical
    server-side tenant and product data without sending wallet keys.
14. x402api hosted services remain outside the key and custody boundary.
15. Package, skill, security, recovery, and compatibility documentation are
    published and tested.

## 20. Resolved and remaining decisions before implementation

The repository, package, license, and V1 wire-identity decisions are resolved:

- **Canonical repository:** `x402api-com/x402api-agent-wallet`, public and
  separate from the generated language SDK repositories.
- **Public package namespace:** `@x402api`; inability to publish under that
  scope blocks release rather than causing a fallback to `@k1hub`.
- **Canonical skill location:** `skills/x402api-pay` in the agent-wallet
  repository and distributed with version-pinned CLI releases.
- **License:** MIT, matching the public x402api package strategy.
- **V1 wire identities:** preserve the deployed literal `com.k1hub...`
  profiles; any renamed profile is a coordinated versioned migration.
- **Source provenance:** extraction is tied to private source commit
  `8bf84404bc16d265d530c86071044f323a110316` and the inventory in
  `docs/source-provenance.md`.
- **Package-name check:** the npm registry returned `404` for both planned
  package names on 2026-08-19. Scope publisher access and first publication
  remain release gates; a registry lookup does not reserve a name.

The remaining items are implementation gates, not reasons to expand scope:

1. **Storage support:** exact macOS and Linux headless unlock mechanisms for
   V1; Windows may follow if it delays the first proven release.
2. **CLI confirmation:** define the non-model confirmation needed for sweep and
   destructive retirement while keeping ordinary purchases autonomous.
3. **Optional payment ceiling:** decide whether wallet creation requires a
   local maximum-per-payment or leaves balance as the only initial limit.
4. **Artifact consumption:** add `--payment-artifact` to WarpMetal or initially
   derive its existing signature-header file from the artifact.
5. **RPC defaults:** decide whether releases include default providers or
   require explicit RPC configuration.
6. **Release provenance:** finish npm trusted publishing, signing, checksums,
   dependency-license evidence, and vulnerability-response verification.

Gas sponsorship, automatic replenishment, additional chains, delegation, and
hosted wallet services are explicitly deferred and do not block these six
V1 decisions.

## 21. Documentation rollout

When implementation reaches Phase 4:

- update x402api agent docs to distinguish the available CLI from conceptual
  wallet-service pseudocode;
- add a dedicated agent-wallet setup and funding guide;
- add CLI and skill installation to x402api `/llms.txt`;
- keep receiving-wallet documentation separate from buyer agent-wallet
  documentation;
- update WarpMetal `/llms.txt`, API guide, landing page, CLI reference, and
  skill in one release;
- describe the wallet as persistent and locally funded, never disposable by
  default; and
- state plainly that the agent can spend the dedicated wallet balance and that
  the owner's primary wallet must never be imported.

Documentation must not advertise automatic gas handling, unsupported rails,
or hosted key protection before those features have release evidence.
