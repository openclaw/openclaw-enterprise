# Upgrade an installation to TokenService and Credential Proxy

Use this procedure to replace Credential Gateway Source delivery. TokenService
holds model keys, Codex PATs and OAuth credentials. Credential Proxy delivers
authorized credentials to OpenShell. Keep the OpenShell Gateway service that
runs the Sandbox, and keep the Slack Channel Secrets used by the OpenClaw Gateway
process.

## Check compatibility before interrupting access

Inventory the installed release, affected Namespace Source IDs, Agent bindings,
active revisions and pending work. Identify the credentials that operators
must re-enroll. Keep the inventory available for the OpenShell operator without
recording credential values.

Check that your Installation can select a supported [TokenService and
Credential Proxy](../credential-proxy.md#prepare-enforcement-trust-and-custody). For GitHub
repository access, check the [installation and Source
prerequisites](../repository-credentials.md) for the replacement.

## Stop and settle before upgrading

Use the [standard production upgrade procedure](production-upgrade.md) for
database and controller changes. If the migration reports an active or
unsettled Gateway reference, use the original release to finish that operation
or stop the affected Agent before retrying. The migration does not check
external OpenShell Provider cleanup. If the migration reports a ServiceAccount
with an older issued PAT, revoke its credential through the original release
before retrying. Issue a fresh PAT after the upgrade.

Start the new release with selected TokenService and Credential Proxy. Apply
the Installation and Helm configuration together.

## Replace bindings and verify before removing owners

The upgrade drops Gateway Source records and clears their saved Agent
assignments. [Enroll replacement Sources](../credential-proxy.md#register-authorize-and-deploy-a-static-source)
and grant access to the exact Sources. Save the new Agent bindings and deploy.
Verify a real model turn and each supported repository operation in use. Check
an allowed and a denied repository request if the Agent has repository access.

Legacy OpenShell Providers can retain usable credentials after the database
upgrade. Follow the [manual OpenShell cleanup](../../reference/credential-sources.md#register-a-source)
with the Workspace operator. Remove only the legacy Providers and profiles
identified by the recorded Source and Namespace.

## Recover from a partial transition

Check which revision is active and which Source it uses. Correct the failed
configuration or access grant before retrying a deployment. Restore a database
only with a release that matches its schema and an explicit recovery decision.
A controller rollback does not restore previous Provider state or authority.
