# Conformance fixtures

The executable Base, Solana, TRON, and x402 HTTP vectors live beside the core
tests in `packages/agent-wallet-core/tests/fixtures`. They were extracted from
the reviewed private implementation at the commit recorded in
`docs/source-provenance.md` and are exercised by `npm test`.

Do not update a signed vector solely to make a failing implementation pass.
Changes require a corresponding producer/facilitator compatibility review.
