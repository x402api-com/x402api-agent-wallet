# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting flow for this repository. Include the affected
version, network, command, reproduction steps, and whether funds or signing
material may be at risk. Refill-notification signature bypass, arbitrary-email
delivery, subscription confusion, deduplication bypass, and tenant/product
spoofing are also security issues.

## Security boundary

The CLI is a hot-wallet tool. A process that can invoke an unlocked wallet can
spend its configured balance. The software reduces accidental key disclosure;
it cannot protect a wallet from a compromised host or malicious operator.

Never include private keys, passphrases, complete payment signatures, wallet
backups, merchant bearer tokens, or live RPC credentials in an issue, test
fixture, log, or support message.

## Supported versions

Version 0.2.4 is the current source and npm release line. No version is yet
production-supported for uncapped mainnet use. Production support remains
gated on the release checklist and capped mainnet evidence in the
implementation plan.
