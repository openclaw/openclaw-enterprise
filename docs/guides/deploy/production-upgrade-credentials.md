# Upgrade retired credential delivery

When upgrading a release that used Credential Gateway or Credential Refresh,
inventory each affected Namespace, Source ID, Agent binding, active revision,
and pending operation without recording credential values. Keep this inventory
for the OpenShell operator. Stop affected Agents and settle work with the old
release. Complete, cancel, or let pending Codex device logins expire. Revoke
older ServiceAccount-issued PATs through their original release before migration.
Existing OAuth grant or confidential Client custody requires an approved transfer
or confirmed reset; stopping Agents does not resolve that custody.
If the migration refuses other retained credential or Repository state, resolve
the reported dependency with the matching old release before retrying.

Remove `credential_gateway` and `credential_refresh` from the Installation and
OpenShell Backend configuration. The image upgrade helper rejects these Driver
changes. Review and rehearse a coordinated upgrade with the target chart,
controller, and Installation settings. Use the [Installation-change guide](production-installation-changes.md)
for Secret and checksum handling only; do not apply its old-controller upgrade
unchanged. Follow the [controller upgrade safeguards](production-upgrade.md#upgrade-the-control-plane).
Select [TokenService and Credential Proxy](../../reference/drivers/selection.md#supported-selections).
The migration drops Gateway Source records and clears their draft assignments;
it does not transfer credentials or clean external Providers. Keep the OpenShell
gateway service and unrelated Channel Secrets. After upgrade, enroll replacement
Sources, grant Agent access, deploy, and verify a model turn and each required
allowed and denied Git operation. Issue fresh ServiceAccount PATs as needed.
Remove only the old Providers and profiles identified by the inventory and
verified ownership. A controller rollback does not restore their state or
authority. Restore a database only with a matching schema and release under an
explicit recovery decision.
