# Upgrade retired credential delivery

Before stopping Agents for an upgrade from Credential Gateway or Credential
Refresh, inventory each affected Namespace, Source type and ID, Agent binding,
active revision, retained Agent revisions with Repository credentials, and pending
operation without recording credential values. A retained standalone v8 Agent
revision blocks migration if it has Repository credentials without Source-backed
authorization, even after Stop. Legacy Gateway OAuth client-credentials tool
Sources are dropped and have no TokenService
successor. Obtain an approved disposition for retained revisions and a replacement
workflow for those tools before starting the cutover. Keep the inventory for
the OpenShell operator. Existing OAuth grant or confidential Client custody
also requires an approved transfer or confirmed reset; Stop does not resolve it.

Stop affected Agents and settle work with the old release. Complete, cancel, or
let pending Codex device logins expire. Revoke
older ServiceAccount-issued PATs through their original release before migration.

Remove `credential_gateway` and `credential_refresh` from the Installation and
OpenShell Backend configuration. The image upgrade helper rejects these Driver
changes. Review and rehearse a coordinated upgrade with the target chart,
controller, and Installation settings. Use the [Installation-change guide](production-installation-changes.md)
for Secret and checksum handling only; do not apply its old-controller upgrade
unchanged. Follow the [controller upgrade safeguards](production-upgrade.md#upgrade-the-control-plane).
Select [TokenService and Credential Proxy](../../reference/drivers/selection.md#supported-selections).
The migration drops Gateway Source records and clears their draft assignments;
it does not transfer credentials or clean external Providers. Keep the OpenShell
gateway service and unrelated credential material. After upgrade, enroll replacement
Sources, grant Agent access, deploy, and verify a model turn and each required
allowed and denied Git operation. Issue fresh ServiceAccount PATs as needed.
Remove only the old Providers and profiles identified by the inventory and
verified ownership. A controller rollback does not restore their state or
authority. Restore a database only with a matching schema and release under an
explicit recovery decision.
