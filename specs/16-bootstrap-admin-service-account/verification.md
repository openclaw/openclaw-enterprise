# Feature Design: Bootstrap administrator service account: verification

[Spec overview](../16-bootstrap-admin-service-account.md). Original record; decisions and status are preserved.

## Testing Plan

- **Unit:** Fresh-only seed shares the exact Role and permission matrix; private JSON is complete, `0600`, fsynced, and rejects existing files/symlinks/unsafe parents without overwrite. Known-failure cleanup touches only attempt-owned files/IDs; uncertain outcomes preserve them.
- **Integration:** Real fresh development and production paths create one committed Installation, human, service principal and usable key; prove Installation and Namespace operations plus Restriction/removed-binding denial. Confirm hashed storage and no secret leakage through logs, audit, HTTP bootstrap, or packaging.
- **Integration:** Reruns preserve IDs/key/file bytes, older installations remain unchanged, and expiry/revocation/removal never resurrects credentials. Race fresh starts with same/different output paths; one seed wins, the loser exits unsuccessfully, cleanup leaves the winner intact, and a whole-startup retry reloads it. Fault an ambiguous commit and prove no credential deletion even when acknowledgement is lost.
- **Manual:** Verify Compose UID 1000 volume/copy permissions and actual Job/PVC retrieval, human sign-in, first key request, saved-ID loss recovery and lost-file/IDs operator recovery, planned rotation/revocation, and unattended import only after success. Rendered Helm alone does not prove PVC permissions; unavailable runtime prerequisites remain explicit gaps.

Use focused real integration tests, `pnpm test:postgres`, `pnpm typecheck`, and `pnpm check:workspace` after implementation. The implementation also validates actual Compose output/copy behavior and a disposable initialization Job/PVC; production deployment remains outside this change.

## Implementation verification

**Shared-initializer revision:** Local verification passed: 32 PostgreSQL tests with no failures and five documented skips, eight standalone worker tests without skips, 140 conformance tests, four packaging tests, TypeScript, workspace, OpenAPI, formatting, and documentation checks. One PostgreSQL skip is an already-bootstrapped guard after the fresh-bootstrap case; four require the separate live Kubernetes Configuration Driver. The PostgreSQL suite covers both production race variants, the development race, unknown COMMIT preservation in both modes, and independent known-failure cleanup diagnostics. A focused fresh-database rerun also verifies that API startup fails before initialization.

Both selected live suites passed without skips: development Compose passed its complete model/TUI flow in 128.8 seconds; production Helm on disposable k3d passed in 158.7 seconds, including TUI model turns before and after revision cutover, network denial, and private credential boundaries. Both exercised the checked-in `scripts/occ-api` helper for `GET /installation` and Namespace creation against actual APIs. Development also verified protected key retrieval from the stopped initializer container. These live runs preceded the subsequent IPv6 loopback allowlist correction; two focused real-entrypoint tests passed for that correction.

The broader non-live integration run had 94 passes, 58 selector-dependent skips, and one unchanged Driver-package fixture failure: the release-age policy requests unpublished local fixture packages from npm and receives 404. The two IPv6 tests are included in those 94 passes; package policy was retained. The PR remains unmerged, and no production rollout is included.

**Predecessor verification at `b6f213c`:** Local validation passed for the earlier bootstrap contract: 31 PostgreSQL tests (five documented skips), eight standalone worker tests, 140 conformance tests, and TypeScript, formatting, workspace, OpenAPI, and flow-document checks. Actual Compose and initialization Job/PVC proofs cover private delivery, human/service access, rotation and revocation, retry preservation, and file permissions. Three review rounds resolved the PVC procedure and shared PostgreSQL fixture issues.

The predecessor development and production deployment paths used the bootstrap service key instead of operator cookies. Both selected real E2E suites passed without skips: Compose covered embedded and dedicated gateway model replies and a two-turn TUI session; production Helm on disposable k3d covered trusted HTTPS provisioning, two-turn TUI sessions before and after revision cutover, network denial, least privilege, and credential-output boundaries. The literal documented `occ_api` helper completed Installation reads and Namespace creation against both live APIs. Guide links, shell syntax, and the two affected flow-document validators passed.

The broader non-live integration run had 92 passes, 57 infrastructure skips, and one unchanged Driver-package fixture failure: pnpm's release-age policy queries unpublished local fixture packages on npm and receives 404. Package policy was retained. Production rollout remains outside this verification.

