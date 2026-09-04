# Agent Wallet confirmed-first 0.2.9 plan

## Project record

### Project details

- **Objective:** accept a valid x402 payment at the confirmed milestone without
  confusing payment acceptance with merchant fulfillment or finality.
- **Users:** autonomous buyers using the Agent Wallet CLI, and merchant tools
  consuming its JSON output.
- **Success:** a successful HTTP `202` plus
  `PAYMENT-RESPONSE.success: true` exits successfully, exposes consistent
  settlement evidence, prevents another ordinary submission, and permits only
  an explicit exact reconciliation.
- **Scope:** core response decoding, durable attempt evidence, CLI output,
  tests, bundled skill, security and release documentation, and version 0.2.9.
- **Non-goals:** tenant-authenticated payment or receipt APIs, receipt polling,
  merchant credentials, chain validation, provisioning, new rails, or release
  publication.
- **Compatibility:** preserve the version-1 attempt record and the existing
  local `state` field. Store new semantic evidence in a separate owner-only
  sidecar so 0.2.8 can still read the base attempt record.
- **Dependency:** x402api OpenAPI 1.3.0 and confirmed-first service behavior are
  deployed at `1decf2faa8ac2f84f42f598532428457735ee872`.
- **Current evidence:** version 0.2.8 excludes HTTP 202 from successful
  submission, conflates `payment submit` with `payment reconcile`, and does not
  decode `com.k1hub.settlement-status`. Baseline focused tests pass: 26 core
  tests and 10 CLI tests.

### Requirements and acceptance

| ID | Requirement or risk | Observable acceptance criterion | Level |
| --- | --- | --- | --- |
| R1 | Confirmed-first success | Every 2xx plus `PAYMENT-RESPONSE.success: true`, including 202, returns exit 0 | integration |
| R2 | Evidence integrity | Header, extension, body, attempt and prior evidence contradictions fail closed | unit / integration |
| R3 | No duplicate payment | A confirmed attempt rejects ordinary submit and only exact reconcile can replay it | integration |
| R4 | Durable recovery | Payment ID, state, booleans, transaction and network survive restart without changing the v1 attempt record | persistence |
| R5 | Invalidation | Reorged/reverted evidence is preserved and returned as a nonretryable invalidation | integration |
| R6 | Credential boundary | No receipt command or tenant credential enters the CLI | inspection |
| R7 | Release integrity | Package, lockfile, docs and bundled skill consistently identify 0.2.9 | build / packaging |

### Architecture

- `protocol/http.ts` owns the strict version-1 settlement-status extension.
- `payment/settlement-evidence.ts` owns body parsing, source reconciliation,
  progression and public evidence types.
- `AttemptStore` keeps the existing record unchanged and atomically writes a
  deterministic settlement sidecar under its private root.
- `submit.ts` owns HTTP classification and returns local attempt state plus
  `paymentState`, `confirmed`, `finalized`, transaction, network and payment ID.
- CLI dispatch distinguishes ordinary submission from explicit reconciliation.
- Raw bodies and signatures remain private files; ordinary stdout contains
  public settlement metadata and paths only.
- Transport and unconfirmed ambiguity retain the same artifact. Contradictory
  evidence fails with `request_binding_mismatch`. Authoritative reorg/revert
  fails with `settlement_invalidated` and never opens a new authorization.
- Rollback is code rollback; the separate sidecar is ignored by 0.2.8 and the
  base attempt remains readable.

### Documentation and API contracts

The CLI JSON contract and exported TypeScript types are the public APIs. Update
the root and package READMEs, `llms.txt`, bundled skill references, threat
model, source provenance, historical design record, and release validation.
Parity is checked by CLI tests, skill validation and pack smoke tests. Receipt
authentication remains explicitly merchant-owned and out of scope.

### Error handling and logging

- `request_binding_mismatch`: malformed or contradictory recognized evidence;
  preserve prior accepted state and store bounded raw evidence.
- `settlement_outcome_unknown`: no authoritative acceptance; retry the exact
  attempt with bounded backoff.
- `settlement_invalidated`: authoritative `reorged` or `reverted`; nonretryable
  and operator/merchant compensation required.
- No new logs are added. JSON errors and evidence paths contain no signatures,
  response bodies, bearer tokens or wallet secrets.

### Authentication and authorization

The local wallet is authenticated by its existing managed unlock source and
authorized by its funded balance plus optional per-payment ceiling. The paid
request is bound to the persisted artifact and exact request digest. Merchant
tenant authentication is not applicable to this buyer-side CLI; consequently
receipt and tenant payment endpoints are deliberately not added.

### Decisions

| Decision | Choice and consequence |
| --- | --- |
| Preserve `state` | It remains the local attempt state; `paymentState` carries the chain settlement state without a 0.2.x breaking change. |
| Sidecar persistence | Keeps old attempt records readable after downgrade while allowing restart-safe evidence. |
| Extension optional | Legacy x402 success remains accepted conservatively as confirmed but not proven finalized. A present extension is strict. |
| Explicit replay mode | `payment submit` cannot replay settled evidence; `payment reconcile` can reuse only the exact stored artifact and envelope. |
| No receipt client | Prevents merchant credentials from crossing into the buyer-wallet boundary. |

### Assumption ledger

| ID | Assumption | Impact | Status | Evidence |
| --- | --- | --- | --- | --- |
| A1 | Service 1.3.0 is deployed before CLI release | high | verified | deployed SHA supplied by coordinator |
| A2 | Extension v1 fields are settlementJobId/state/confirmed/finalized | high | verified | deployed service implementation and handoff |
| A3 | Current local `settled` means successful payment evidence | high | verified | 0.2.8 submit state machine |
| A4 | Receipt routes require tenant authentication | high | verified | deployed API contract and handoff |

### Threat and failure model

| Threat or failure | Control | Verification |
| --- | --- | --- |
| Duplicate payment after confirmation | live-attempt uniqueness plus submit/reconcile mode gate | core and CLI tests |
| Forged or contradictory response fields | strict extension/body reconciliation and network binding | negative matrix |
| Finality regression or reorg | monotonic sidecar with explicit invalidation transition | persistence and submit tests |
| Downgrade corrupts attempt | new fields live outside the exact v1 record | old-record compatibility test |
| Credential expansion | no tenant URL/token surface | help and source inspection |

### Master phase map

| Phase | Outcome | Exit criteria | Status |
| --- | --- | --- | --- |
| P1 | Strict evidence codec and compatible persistence | protocol and attempt-store tests pass | completed |
| P2 | Confirmed-first submission and replay boundary | submission and CLI tests pass | completed |
| P3 | Documentation and release metadata | version, skill and package checks pass | completed |
| P4 | Integrated verification | full `npm run check` plus diff/security review pass | completed |

## Completed phase subplan

- **Phase:** P4, integrated verification and release handoff.
- **Entry:** P1-P3 gates verified; implementation authorized: yes.
- **Owner:** Agent Wallet implementation subagent.
- **Fresh recovery reviewer:** completed through the coordinating parent. The
  reviewer found runtime replay, identity-binding, crash-sidecar, legacy
  finality, and state-transition gaps; each was fixed and the adversarial and
  full gates were rerun successfully.
- **Error/logging review:** yes; fail closed and store no new secret output.
- **Authentication review:** yes; merchant authentication remains excluded.
- **Documentation review:** yes; public CLI and skill changes are mapped above.

| Subpart | Deliverable | Oracle | Checks | Status |
| --- | --- | --- | --- | --- |
| P1.S1 | Strict extension and body evidence model | known v1 accepted; malformed/contradictory evidence rejected | HTTP/evidence unit tests | verified |
| P1.S2 | Atomic backward-compatible settlement sidecar | old record unchanged; evidence survives restart and progresses monotonically | attempt-store tests | verified |
| P2.S1 | Successful 202 and output fields | 202+success exits 0 and is settled/pending fulfillment | submit tests | verified |
| P2.S2 | Submit/reconcile boundary | settled submit rejected; exact reconcile allowed | core and CLI tests | verified |
| P3.S1 | 0.2.9 docs, skill and metadata | all version and behavior references agree | validators | verified |
| P4.S1 | Cross-network and production-build verification | Base and Solana confirmed evidence plus packaged public API behave identically | full check / built probe | verified |

### Frozen phase-gate manifest

```text
npm test --workspace @x402api/agent-wallet-core -- --run tests/http.test.ts tests/settlement-evidence.test.ts tests/attempt-store.test.ts tests/submit.test.ts
npm test --workspace @x402api/agent-wallet-cli -- --run tests/cli.test.ts
npm run check
npm run release:verify -- v0.2.9
git diff --check
```

## Verification log

- Entry baseline: 26 focused core tests and 10 CLI tests passed.
- An initial baseline invocation used workspace-root test paths from inside the
  workspace and found no tests; the corrected package-relative invocation is
  the recorded baseline above.
- P1 gate: 25 settlement-evidence and attempt-store tests passed, including
  old-record shape preservation, restart recovery, confirmed-to-finalized
  progression, invalidation, regression rejection, and explicit replay mode;
  the core typecheck passed. Protocol tests independently reject an unknown
  extension version and success/status contradictions.
- P2 gate: 59 focused core tests and 11 CLI tests passed. An HTTP 202 with
  successful confirmed evidence exits zero, exposes public settlement fields,
  persists across status lookup, blocks a second ordinary submit, and permits
  an exact reconcile with the identical signature. Reorg and response-network
  contradiction paths also passed; core build and CLI typecheck passed.
- P3 gate: package and lock metadata consistently report 0.2.9, skill
  validation passed, source provenance identifies deployed service SHA
  `1decf2faa8ac2f84f42f598532428457735ee872`, and docs explicitly retain the
  buyer/merchant credential boundary. The expanded focused suite passes 59
  core tests plus 11 CLI tests.
- P4 gate: the final focused suite passes 59 core tests, including a Solana
  confirmed-first response oracle, plus 11 CLI tests. The complete
  `npm run check` passes lint, typecheck, 11 CLI tests, 126 core tests, both
  builds, skill validation, and clean-consumer pack smoke (74 core files and
  15 CLI files). `npm run release:verify -- v0.2.9` and `git diff --check`
  pass. A separate probe against the built core package decoded matching
  version-1 header/body evidence as confirmed and not finalized.
- Fresh recovery probes additionally verify that unknown replay modes fail
  closed; settlement IDs and networks cannot diverge; durable sidecars remain
  authoritative across record-write crashes; legacy responses cannot claim
  finality; direct typed response objects enforce success/extension parity;
  and settlement progression follows the deployed service graph, including
  safe skipped polls without accepting regressions or terminal resurrection.
- Completion: all requirements R1-R7 are implemented, locally verified, and
  independently recovery-reviewed. Receipt polling and merchant credentials
  remain outside the wallet boundary; commit, CI, tagging, and publication are
  separate release operations performed after this implementation gate.
