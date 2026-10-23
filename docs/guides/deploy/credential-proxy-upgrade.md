# Upgrade an installation to Credential Proxy

Start with [Credential Proxy setup](../credential-proxy.md). A schema upgrade,
a live Secret adoption, and removal of a Credential Gateway are different
operations. Existing static Gateway owners may remain. **There is no general
in-place Gateway-to-Proxy ownership transfer or qualified stock protected
replacement in this release.**

## Decide what can move

| Existing use                                                       | Upgrade decision                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static `openai` source                                             | May remain Gateway-owned. An unbound source can explicitly adopt protected live reads, but retains its owner. Replacing that owner requires a supported Proxy-owned registration path; adoption alone cannot remove Gateway.          |
| Static `codex-pat` or `bearer-token`                               | Keep the Gateway path unless the selected Proxy explicitly supports that source and operation. Do not treat the static inference profile as a universal token injector.                                                               |
| `codex-oauth`, `oauth2-client-credentials`, `oauth2-refresh-token` | Keep existing Gateway/Refresh sources and their enrollment state; this does not promise arbitrary fresh refresh registration alongside a static Proxy profile. No general transfer of refresh grants to Token Service is implemented. |
| Proxy-owned metadata                                               | `github-app-metadata` (with its issuer configured) and `credential-free-repository-metadata` have narrow metadata profiles. Neither replaces static inference or Git delivery.                                                        |
| Prepared GitHub App access                                         | Token Service owns preparation and retirement. Choose qualified protected delivery or explicit native prepared Git; do not copy tokens between owners.                                                                                |
| Earlier broker trial or legacy `drivers.repo`                      | New startup rejects these selections. Drain on the original release before switching; the new release cannot restart that owner.                                                                                                      |

Creating a replacement source produces a new identity. Reauthorize the exact
source for the operator and Agent principal, replace bindings, and admit a new
revision. Re-enroll provider credentials where the replacement requires it.
An approval for a narrower operation, finite lifetime, or different repository
scope never becomes broader or standing automatically. The static setup linked
from this guide creates a Gateway-owned source, so it does not by itself provide
the replacement registration needed to remove Gateway.

## Check compatibility before interrupting access

First inventory the installed release, schema receipts, Driver selections, source
IDs and `ownerCapability`, selected Agent revisions, and outstanding operations.
Use `occ credential-source list`, then `get` for live status, and `occ agent get`,
`revisions`, and `deployment-status`. Require visibility over every affected
Namespace: an empty permission-filtered list does not prove no dependencies.

**Keep Credential Gateway while using the bundled OpenShell Backend and Sandbox,
even with no credential sources.** Both Backend members are mandatory. Removing
Gateway requires a different qualified composition, or a future Backend contract
with Gateway-independent source and Harness admission. Verify that a supported
replacement exists for every retained source and model authentication path
before withdrawing access. Selecting Credential Proxy alone does not provide one.

### Keep schema histories separate

The migrator recognizes the 59-receipt history before Credential Proxy and the
62-receipt history through `0062_credential_delivery_custody`. Both upgrade to
63 receipts, ending at `0063_prepared_attempt_settlement`. The
[migration reference](../../reference/settings/operations.md) lists the supported
histories. The migrator checks receipt hashes, timestamps, and the database
catalog; a count alone does not establish compatibility.

The migrator refuses an unsupported history before applying migrations. Keep a
preview database with its matching release to settle outstanding work. Use a
separate database for a fresh preview; never delete or relabel receipts to force
an upgrade.

For a compatibility-only upgrade, quiesce API, workers and other database writers,
keep a recoverable database copy and matching release, and check the history
using the existing migrator connection in `OCC_MIGRATION_DATABASE_URL`:

```bash
pnpm db:migrate --check
```

If the check fails, stop. If it reports `completed`, no migration is pending.
For `preCredentialProxy` (59 receipts), migration applies `0060` through `0063`.
For `prePreparedAttemptSettlement` (62 receipts), it applies only `0063`.
Confirm the target and authorization before running the migration and checking again:

```bash
pnpm db:migrate
pnpm db:migrate --check
```

Migration reports its **starting** history; the last check must report
`completed`. Upgrade the control plane without mixed-version
writers. Keep existing Driver selections and admissions, then verify retained
workflows. **You can stop here without revoking a working source.** Migration
preserves Gateway ownership and records older revisions as version 2 `unprotected`;
it does not enable protected execution or broaden approvals. Production also
follows the [coordinated upgrade procedure](production-upgrade.md).

## Stop and settle before upgrading

Use this sequence only for a supported ownership or delivery cutover, including
retirement of the earlier broker trial. New startup rejects `drivers.repo` and
`broker-trial`; it cannot restart that owner.

1. After checking replacement support, stop new admissions. Withdraw affected
   access while its original owner remains available:

   ```bash
   ./bin/occ agent credential-withdrawal request "$AGENT_ID" "$SOURCE_ID"
   ./bin/occ agent credential-withdrawal get "$AGENT_ID" "$SOURCE_ID" -o json
   ```

   Inspect `state`, `reason`, and `withdrawalInProgress`. If the Driver can
   reduce policy in place, require `revoked` and a fresh denied request. If it
   reports `CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT` with
   `withdrawalInProgress: false`, proceed to step 2; waiting for this attempt to
   return `revoked` will not fence the execution. While it is `true`, a version
   that just became selected has one more attempt queued; wait for it first.
   If `revisionId` names a version other than the selected one, see
   [withdrawal](../../reference/credential-sources/withdrawal.md#withdraw-a-source-from-an-agent) instead.
   Repository access uses the [standing or finite withdrawal sequence](../credential-proxy.md#withdraw-repository-access).

2. When the runtime must be fenced, request a stop:

   ```bash
   ./bin/occ agent stop "$AGENT_ID"
   ./bin/occ agent runtime "$AGENT_ID" -o json
   ```

   Stop queues reconciliation. Wait for observed runtime retirement; an accepted
   command does not prove it. Stop preserves the Agent and persistent state,
   but does not settle a pending credential withdrawal. Keep unresolved work
   with its original owner. Expect interruption until a
   replacement revision is ready. Do not delete the Agent merely to replace a source.

3. Let the original owner close sessions and settle issuance, use, delivery and
   retirement. Preserve its database, registry, custody key, issuer access and
   operation identities. If an outcome is unknown, stop the cutover. Do not replay
   an uncertain issuance or send, or transfer its receipt to new authority.
4. Once settlement completes, stop all database writers and follow the accepted
   schema upgrade above. Change Installation and Helm configuration together;
   a Helm rollout cannot settle custody or migrate a grant.

## Replace bindings and verify before removing owners

Keep the old Gateway selected while removing its references and deleting its
sources. Stop alone leaves selected revisions referenced; withdrawal also leaves
the source in that revision. Update the Agent with its `configurationId`,
replacement `harnessAuth`, and complete replacement `credentialSources` list
(or `[]` when no source is required), then deploy a new revision through the
[normal setup steps](../credential-proxy.md#register-authorize-and-deploy-a-static-source).
Do not remove a Harness source without supplying a supported authentication path.

Verify allowed use, denied use, applicable renewal, withdrawal, and recovery on
the replacement. For Git access, also verify a continuing conversation with an
independent model source. A saved binding or successful schema migration is
insufficient. The stronger protected path stops here when qualification is
missing; native prepared Git is an explicit alternative, never a fallback.

Delete each unreferenced old source through its original owner:

```bash
./bin/occ credential-source delete "$SOURCE_ID"
```

A `409` means references or withdrawal work remain; finish those operations.
A `503` leaves cleanup incomplete. Retain the owner, correct its dependency,
and retry its supported cleanup. Do not delete Secrets or custody keys first.

Full Gateway removal is impossible while retaining the bundled OpenShell Backend
and Sandbox. For a qualified replacement composition, first prove that no source,
draft, selected revision, pending deployment/provisioning job, withdrawal, worker
or unsettled custody needs the old owner. A `credential_source` Harness also
snapshots its Gateway owner; while Gateway is selected, an ordinary Secret-backed
Harness is not a supported substitute. Remove Refresh with Gateway if selected,
because Refresh requires it. Update Backend membership and deployment settings
together only after those dependencies are gone.

The OpenShell Gateway **service** also serves Sandbox and middleware operations.
Keep it and its TLS/network dependencies while any retained component needs them.

There is no single public command that certifies all custody is drained. If the
owner's diagnostics cannot prove settlement, leave its configuration and recovery
state available and stop removal. Missing work includes a supported replacement
for each retained source type and qualified enforcement of that replacement.

## Recover from a partial transition

Keep old and replacement source identities distinct. Correct configuration and
resume the original cleanup operation; do not revive withdrawn access or reuse
old approval evidence for a new revision. A new authorized binding can resume
the same Agent, but its interrupted request is not automatically replayable.
If delivery is uncertain, fence the old recipient and reconcile the original
operation before creating another. Restore a database only with its matching
release and an explicit recovery decision; rolling back binaries alone cannot
undo schema, provider, or authorization changes.
