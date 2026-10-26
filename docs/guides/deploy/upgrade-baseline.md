# Record the pre-upgrade baseline

Record the starting state of a production installation before you run the
[production image upgrade](production-upgrade.md). The
[upgrade checklist](upgrade-checklist.md#record-the-starting-state) lists what to
record; this page gives commands for its Helm, Kubernetes, OCC, PostgreSQL and
workspace items. The upgrade helper keeps its own evidence of the release it
changes. This baseline is what you compare against after the upgrade and use if
you must restore.

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

The helper refuses to run when the protected values or Installation differ from
the live release, so compare them now. Each check prints a message only when the
files differ; resolve any difference before the upgrade.

```bash
helm history oce "${helm_args[@]}" >"$BASELINE/helm-history.txt"
helm get values oce "${helm_args[@]}" --output yaml >"$BASELINE/live-values.yaml"
diff <(yq -o=json . /secure/occ/values.yaml | jq -S .) \
  <(yq -o=json . "$BASELINE/live-values.yaml" | jq -S .) ||
  echo 'The protected values differ from the live release.' >&2
OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' "$BASELINE/live-values.yaml")"
OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' "$BASELINE/live-values.yaml")"
"${kube[@]}" -n openclaw-system get secret "$OCC_INSTALLATION_SECRET" -o json |
  jq '{installationId: .metadata.annotations["openclaw.dev/installation-id"]}' >"$BASELINE/installation-secret.json"
"${kube[@]}" -n openclaw-system get secret "$OCC_INSTALLATION_SECRET" -o json |
  jq -j --arg key "$OCC_INSTALLATION_KEY" '.data[$key] | @base64d' >"$BASELINE/live-installation.yaml"
diff <(yq -o=json . /secure/occ/installation.yaml | jq -S .) \
  <(yq -o=json . "$BASELINE/live-installation.yaml" | jq -S .) ||
  echo 'The protected Installation differs from the live Secret.' >&2
```

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

```bash
"${occ_json[@]}" installation get >"$BASELINE/installation.json"
"${occ_json[@]}" installation deployment-inventory >"$BASELINE/deployment-inventory.json"
"${occ_json[@]}" namespace list >"$BASELINE/occ-namespaces.json"
jq -r '.[].id' "$BASELINE/occ-namespaces.json" | while read -r ns; do
  "${occ_json[@]}" --namespace "$ns" agent list >"$BASELINE/occ-$ns-agents.json"
  "${occ_json[@]}" --namespace "$ns" secret list >"$BASELINE/occ-$ns-secrets.json"
  "${occ_json[@]}" --namespace "$ns" iam role list >"$BASELINE/occ-$ns-roles.json"
  "${occ_json[@]}" --namespace "$ns" iam access-binding list >"$BASELINE/occ-$ns-access-bindings.json"
done
```

The deployment inventory lists every Namespace, Agent, desired state and selected
version. A controller that predates `deployment-inventory` cannot answer it;
the per-Namespace `agent list` records the same Agents. `secret list` returns
metadata only.

## Record the database

```bash
psql "$OCC_MIGRATION_DATABASE_URL" -At \
  -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' \
  >"$BASELINE/migrations.txt"
pg_dump --format=custom --file "$BASELINE/openclaw_enterprise.pgdump" "$OCC_MIGRATION_DATABASE_URL"
pg_restore --list "$BASELINE/openclaw_enterprise.pgdump" >/dev/null
```

`migrations.txt` holds the migration receipts. `pg_restore --list` only checks
that the dump is readable. Before relying on the backup, restore it into a
separate disposable database. Provision the required roles first, and use an
identity authorized to restore ownership and grants. Set `RESTORE_DATABASE_URL`
to that database privately. Use a `pg_dump` at least as new as the server.

```bash
pg_restore --exit-on-error --single-transaction --dbname "$RESTORE_DATABASE_URL" \
  "$BASELINE/openclaw_enterprise.pgdump"
```

Keep normal ownership and ACL restoration; do not use `--no-owner` or
`--no-acl`. Set `RESTORED_MIGRATION_DATABASE_URL` privately to the dedicated
migrator login for that same restored database. From the matching release, run:

```bash
OCC_MIGRATION_DATABASE_URL="$RESTORED_MIGRATION_DATABASE_URL" pnpm db:migrate:production --check
```

Require exit 0, `migration.checked`, and the expected `history`. Compare all
receipts with the baseline:

```bash
psql "$RESTORED_MIGRATION_DATABASE_URL" -At \
  -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' |
  diff -u "$BASELINE/migrations.txt" -
```

Compare the data you must retain with the appropriate baseline. The [catalog boundary](../../reference/settings/operations.md#migration-history)
recognizes one reviewed logical-restore equivalent. A successful check does not
prove backup completeness or provenance, and does not authorize a launch,
recovery, or retry. Do not restore over the original database.

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

## Compare after the upgrade

Rerun the same commands into a new directory and compare. Expect new image
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
