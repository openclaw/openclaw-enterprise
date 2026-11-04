# Record the pre-upgrade baseline

Record the starting state of a production installation before you run the
[production image upgrade](production-upgrade.md). The
[upgrade checklist](upgrade-checklist.md#record-the-starting-state) lists what to
record; this page gives commands for its Helm, Kubernetes, OCC, PostgreSQL and
workspace items. The upgrade helper keeps its own evidence of the release it
changes. Use the baseline to compare state after the upgrade and to rehearse a
database restore before maintenance.

## Set the inputs

Use the protected files and OCC connection from the
[upgrade preparation](production-upgrade.md#prepare-the-release) and the OCC CLI
you will pass to the helper. Run the commands from a host that can reach the
cluster and the database. For the database, use the `occ_migrator` role, which
owns the `occ` and `drizzle` schemas, with its password in a protected
[password file](https://www.postgresql.org/docs/current/libpq-pgpass.html) and
TLS verification in the URL. Keep every output private: the dump contains all
control-plane data.

```bash
umask 077
export BASELINE="/secure/occ/upgrades/baseline-$(date -u +%Y%m%dT%H%M%SZ)"
export PGPASSFILE=/secure/occ/pgpass
export OCC_MIGRATION_DATABASE_URL='postgresql://occ_migrator@<postgres-host>:5432/<database>?sslmode=verify-full&sslrootcert=/secure/occ/database-ca.pem'
mkdir "$BASELINE"
kube=(kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>')
helm_args=(--kubeconfig /secure/occ/kubeconfig --kube-context '<reviewed-context>' --namespace openclaw-system)
occ_json=(/secure/occ/bin/occ --output json)
```

## Record the release and its configuration

From the repository root, use Bash, yq v4, and jq to capture the live release
and compare its configuration with the protected files. Set the inputs above
first and keep shell tracing disabled. The subshell stops if a read or comparison
fails; read failures exit 2 without printing configuration.

```bash
(
  set -euo pipefail
  trap 'echo "Baseline read failed: check access, tools, and inputs before retrying." >&2; exit 2' ERR
  helm history oce "${helm_args[@]}" 2>/dev/null >"$BASELINE/helm-history.txt"
  helm get values oce "${helm_args[@]}" --output yaml 2>/dev/null >"$BASELINE/live-values.yaml"
  scripts/compare-upgrade-baseline /secure/occ/values.yaml "$BASELINE/live-values.yaml" || exit "$?"
  OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' "$BASELINE/live-values.yaml" 2>/dev/null)"
  OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' "$BASELINE/live-values.yaml" 2>/dev/null)"
  "${kube[@]}" -n openclaw-system get secret "$OCC_INSTALLATION_SECRET" -o json 2>/dev/null |
    jq '{installationId: .metadata.annotations["openclaw.dev/installation-id"]}' 2>/dev/null >"$BASELINE/installation-secret.json"
  "${kube[@]}" -n openclaw-system get secret "$OCC_INSTALLATION_SECRET" -o json 2>/dev/null |
    jq -ej --arg key "$OCC_INSTALLATION_KEY" '.data[$key] | strings | @base64d' 2>/dev/null >"$BASELINE/live-installation.yaml"
  scripts/compare-upgrade-baseline /secure/occ/installation.yaml "$BASELINE/live-installation.yaml" || exit "$?"
)
```

The comparison prints `Configurations match.` and exits 0 for equal mappings,
including `{}`. It ignores field order and formatting; scalar types and array
order must match. Each file must contain exactly one YAML mapping. Exit 1 means
configuration drift: reconcile the files before maintenance. Exit 2 means a
missing, unreadable, empty, invalid, nonmapping, or multiple-document input, or a
parser failure. Correct the input or tool setup and retry. The comparison does
not print paths or configuration or write parsed data to disk.

`installation-secret.json` records the `openclaw.dev/installation-id`
annotation. When it is missing, [bind the Installation once](production-upgrade.md#bind-the-installation-once)
before the upgrade.

## Record images and Kubernetes state

```bash
"${kube[@]}" get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{range .status.initContainerStatuses[*]} {.name}={.imageID}{end}{range .status.containerStatuses[*]} {.name}={.imageID}{end}{"\n"}{end}' \
  >"$BASELINE/pod-images.txt"
"${kube[@]}" get namespaces -o json |
  jq -S '[.items[] | {name: .metadata.name, labels: .metadata.labels}]' >"$BASELINE/namespaces.json"
for kind in rolebindings networkpolicies services; do
  "${kube[@]}" get "$kind" -A -o json |
    jq -S '[.items[] | {namespace: .metadata.namespace, name: .metadata.name, roleRef, subjects, spec}]' \
      >"$BASELINE/$kind.json"
done
"${kube[@]}" get storageclasses -o json |
  jq -S '[.items[] | {name: .metadata.name, provisioner, reclaimPolicy, volumeBindingMode,
    allowVolumeExpansion, parameters,
    default: .metadata.annotations["storageclass.kubernetes.io/is-default-class"]}]' \
    >"$BASELINE/storageclasses.json"
"${kube[@]}" get pvc -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,UID:.metadata.uid,VOLUME:.spec.volumeName' \
  >"$BASELINE/pvcs.txt"
# Only with private Agent routing (Gateway API resources):
"${kube[@]}" get gateways,httproutes -A -o yaml >"$BASELINE/gateway-api.yaml"
```

`pod-images.txt` records the digest each container actually runs, which the
configured image reference alone does not prove. The PVC UIDs must be unchanged
after the upgrade: a new UID means the volume and its Agent data were replaced.

## Record the OCC inventory

On controllers that support it, record the installation-wide deployment inventory:

```bash
"${occ_json[@]}" installation deployment-inventory >"$BASELINE/deployment-inventory.json"
```

Require this read to succeed. It requires Installation `administer` and read
access to each Namespace and Agent. For a running Agent with a selected revision
and no deployment in progress, it also checks Agent `deploy` and revision read
access. An authorization or connection failure does not mean the endpoint is
unavailable on that release.

If the controller predates this endpoint, obtain the expected Namespace and Agent
IDs, desired states and selected revisions from an independent inventory held by
the resource or database owner. Include stopped Agents. Compare those records
with the lists below before changing production. If an ID or state is missing
or the expected inventory is unknown, stop. This fallback does not replace the
deployment inventory required by the image helper for a runtime upgrade.

For either release, collect the remaining records in Bash:

```bash
(
  set -euo pipefail
  "${occ_json[@]}" installation get >"$BASELINE/installation.json"
  "${occ_json[@]}" namespace list >"$BASELINE/occ-namespaces.json"
  jq -r '.[].id' "$BASELINE/occ-namespaces.json" | while read -r ns; do
    "${occ_json[@]}" --namespace "$ns" agent list >"$BASELINE/occ-$ns-agents.json"
    jq -e 'all(.[]; .configurationReadError == null)' "$BASELINE/occ-$ns-agents.json" >/dev/null
    "${occ_json[@]}" --namespace "$ns" secret list >"$BASELINE/occ-$ns-secrets.json"
    "${occ_json[@]}" --namespace "$ns" iam role list >"$BASELINE/occ-$ns-roles.json"
    "${occ_json[@]}" --namespace "$ns" iam access-binding list >"$BASELINE/occ-$ns-access-bindings.json"
  done
)
```

Treat a failed command or unreadable saved configuration as an incomplete
baseline. Even on success, ordinary Namespace and Agent lists omit resources
the caller cannot read. Reconcile IDs and states with the expected inventory;
matching counts alone do not establish coverage. `secret list` returns metadata only.

## Record the database

```bash
psql "$OCC_MIGRATION_DATABASE_URL" -At \
  -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' \
  >"$BASELINE/migrations.txt"
pg_dump --format=custom --file "$BASELINE/openclaw_enterprise.pgdump" "$OCC_MIGRATION_DATABASE_URL"
pg_restore --list "$BASELINE/openclaw_enterprise.pgdump" >/dev/null
```

`migrations.txt` holds the pre-upgrade migration receipts. `pg_restore --list`
checks that the dump is readable. Rehearse the restore in a separate, empty,
disposable database before maintenance. Provision the required roles first and
use an identity authorized to restore ownership and grants. Set
`RESTORE_DATABASE_URL` to that database privately. Keep passwords in the
protected password file because the PostgreSQL clients take URLs as arguments.
Use a `pg_dump` at least as new as the source server and `pg_restore` from the
same PostgreSQL client release. Stop the rehearsal if any command fails.

```bash
pg_restore --exit-on-error --single-transaction --dbname "$RESTORE_DATABASE_URL" -- \
  "$BASELINE/openclaw_enterprise.pgdump"
```

Keep normal ownership and ACL restoration; do not use `--no-owner` or
`--no-acl`. Set `RESTORED_MIGRATION_DATABASE_URL` privately to the dedicated
migrator login for that same restored database. From the root of a checkout of
the pre-upgrade release, install its dependencies and run:

```bash
pnpm install --frozen-lockfile
OCC_MIGRATION_DATABASE_URL="$RESTORED_MIGRATION_DATABASE_URL" pnpm db:migrate:production --check
```

Require exit 0, `migration.checked`, and the expected pre-upgrade `history`.
Compare the rehearsal database's receipts with the pre-upgrade receipts:

```bash
(
  set -euo pipefail
  psql "$RESTORED_MIGRATION_DATABASE_URL" -At \
    -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' |
    diff -u "$BASELINE/migrations.txt" -
)
```

Compare the data you must retain with the pre-upgrade baseline. The
[migration history check](../../reference/settings/operations.md#migration-history)
recognizes a reviewed logical restore of the catalog. A successful check does
not prove backup completeness or provenance or authorize a launch, recovery,
or retry. Do not restore over the original database.

## Restore the retained candidate database

If an upgrade gate fails after the candidate accepts writes, keep writers
stopped and retain the candidate database. Reconcile accepted and uncertain
operations before capture. A pre-upgrade archive can restore successfully and
omit those writes. Take a fresh archive and receipt snapshot while writers
remain stopped.

Use the protected password file, TLS settings and PostgreSQL clients from the
rehearsal. Set `CANDIDATE_MIGRATION_DATABASE_URL` privately to the retained
candidate database's `occ_migrator` login. Provision the required roles on the
target PostgreSQL server and create a separate, empty database. Confirm that
`RESTORE_DATABASE_URL` and `RESTORED_MIGRATION_DATABASE_URL` both name that
target, using the restore identity and dedicated migrator respectively.
Preserve ownership and grants.
Keep the candidate intact. Do not restore over it, add `--clean`, or drop schemas.

Run the block with Bash and jq from the root of the candidate release checkout
with its dependencies installed. Set `EXPECTED_CANDIDATE_HISTORY` from the
reconciled migration state. Use `completed` if the candidate applied all its
migrations. Keep shell tracing disabled. The block stops on a failed command,
unexpected history, or different receipts.

```bash
(
  set -euo pipefail
  umask 077
  : "${CANDIDATE_MIGRATION_DATABASE_URL:?}" "${RESTORE_DATABASE_URL:?}"
  : "${RESTORED_MIGRATION_DATABASE_URL:?}" "${EXPECTED_CANDIDATE_HISTORY:?}"
  CANDIDATE_RETURN=$(mktemp -d /secure/occ/upgrades/candidate-return.XXXXXXXX)
  printf 'Candidate recovery evidence: %s\n' "$CANDIDATE_RETURN"
  psql "$CANDIDATE_MIGRATION_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 \
    -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' \
    >"$CANDIDATE_RETURN/candidate-migrations.txt"
  pg_dump --format=custom --file "$CANDIDATE_RETURN/candidate.pgdump" "$CANDIDATE_MIGRATION_DATABASE_URL"
  pg_restore --exit-on-error --single-transaction --dbname "$RESTORE_DATABASE_URL" -- \
    "$CANDIDATE_RETURN/candidate.pgdump"
  NODE_ENV=production OCC_MIGRATION_DATABASE_URL="$RESTORED_MIGRATION_DATABASE_URL" \
    node scripts/migrate-production.mjs --check >"$CANDIDATE_RETURN/restored-history.json"
  jq -se --arg expected "$EXPECTED_CANDIDATE_HISTORY" \
    'length == 1 and .[0].event == "migration.checked" and .[0].history == $expected' \
    "$CANDIDATE_RETURN/restored-history.json" >/dev/null
  psql "$RESTORED_MIGRATION_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 \
    -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' \
    >"$CANDIDATE_RETURN/restored-migrations.txt"
  cmp "$CANDIDATE_RETURN/candidate-migrations.txt" "$CANDIDATE_RETURN/restored-migrations.txt"
)
```

Compare the restored Agent revisions, selected revisions, audit records and
other required data with the retained candidate. Confirm that the restored
database contains the records for each accepted operation. Keep writers stopped
if any required record differs or an operation remains uncertain. Verify Gateway
and workspace volumes and compatibility with any older image before switching
writers.

## Record Agent data

For each Agent whose data you must keep, record the hash of a file the Agent or
a user wrote and the number of files in its workspace. This example uses a
dedicated Codex Agent's Harness Pod, with `TENANT_NAMESPACE` and `AGENT_ID` from
the [production Agent guide](production-agents.md):

```bash
HARNESS_POD=$("${kube[@]}" -n "$TENANT_NAMESPACE" get pods \
  -l "openclaw.dev/agent=$AGENT_ID,openclaw.dev/workload-role=agent" \
  -o jsonpath='{.items[0].metadata.name}')
"${kube[@]}" -n "$TENANT_NAMESPACE" exec "$HARNESS_POD" -c agent -- \
  sh -c 'sha256sum /home/node/workspace/<file>; find /home/node/workspace -type f | wc -l' \
  >"$BASELINE/workspace-$AGENT_ID.txt"
```

For an embedded Agent, use its gateway Pod (`openclaw.dev/workload-role=gateway`),
container `gateway`, and `/home/node/.openclaw/workspace`. If the
dedicated Codex seccomp profile is in use, also record its file hash on every
eligible node, as the [Codex sandbox procedure](codex-sandbox.md) shows.

## Compare the candidate with the installed manifest

Before the upgrade, compare the candidate chart render with the manifest Helm
saved for the revision recorded by a successful
[upgrade preflight](production-upgrade.md#rehearse-before-the-maintenance-window).
Use its `UPGRADE_EVIDENCE` directory and the same release, namespace and context.
Keep shell tracing off and keep the comparison files private because manifests
can contain Secrets.

```bash
(
  set +x
  set -euo pipefail
  umask 077
  comparison=$(mktemp -d "$UPGRADE_EVIDENCE/manifest-comparison.XXXXXXXX")
  revision=$(jq -er '.version | select(type == "number" and . >= 1)' \
    "$UPGRADE_EVIDENCE/before-helm-status.json")
  helm get manifest oce --revision "$revision" \
    --kubeconfig /secure/occ/kubeconfig --kube-context '<reviewed-context>' \
    --namespace openclaw-system >"$comparison/installed.yaml" 2>"$comparison/helm.err"
  test -s "$comparison/installed.yaml"
  test -s "$UPGRADE_EVIDENCE/rendered.yaml"
  diff -u "$comparison/installed.yaml" "$UPGRADE_EVIDENCE/rendered.yaml" \
    >"$comparison/manifest.diff" || test "$?" -eq 1
  printf 'Review the private comparison in %s\n' "$comparison"
)
```

Stop if the comparison cannot run. Use the diff to locate changes, then check
the required objects and fields in both files. Account for intended changes
such as the selected image digests. Review `server-dry-run.txt` for Helm's
upgrade-mode output and hooks. Helm history omits later live patches. Check
affected objects against the [live Kubernetes records](#record-images-and-kubernetes-state)
as well. Read the live object for any required field that the baseline does
not record.

If a required setting is missing, put it in supported chart values or
Installation settings. For example, retain a required placement label in
`controlPlane.nodeSelector` in the protected Helm values and in the
[profile input](installation-profiles.md#use-rendered-files) if you generate
those values. Reconcile protected settings with the installed release in a
separate reviewed configuration change. Use the candidate file flags only for
the [settings they support](production-upgrade.md#include-reviewed-settings).
Rerun the preflight and comparison after a change to the release or inputs.
The helper uses the stock chart without a post-renderer. Stop if a required
change still depends on a live patch or a post-renderer that the helper does
not run.

## Compare after the upgrade

Record the baseline again in a new directory and compare. Expect new image
digests and Pod names, new Helm revisions, the new controller image and
Installation checksum in the live values, receipts appended by the release's
migrations and, after a runtime release, new selected Agent revision IDs. Several of an
Agent's NetworkPolicies and, for a dedicated Agent, its Harness Service select
the selected version, so a runtime release changes the Agent revision ID in those
selectors. A dedicated Agent's gateway Deployment, Service and HTTPRoute can
also be recreated; the Service gets a new cluster IP and the HTTPRoute new
Agent revision annotations. Agents add and delete
their own workspace files, so the file count can change slightly. Investigate
any other change, in particular a changed PVC UID, a missing or altered earlier
receipt, any other NetworkPolicy, Service or RoleBinding change, a different
workspace hash, or a workspace that is empty or nearly so.

The checklist's Configuration, Preset, Backend, service account, audit,
session and gateway state items, and its authentication, credential, repository
and CredentialSource items, have no command here; record them as that page
describes.
