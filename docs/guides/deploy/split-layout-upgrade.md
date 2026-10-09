# Upgrade a split-layout Installation

Single-cluster Installations created by the 2026-09-28 release keep each
Namespace's Gateways, Gateway state and canonical Secrets in a separate
`oce-gateways-<hash>` namespace. The current controller refuses to start on that
layout; the [breaking-change notice](breaking-changes.md#2026-10-05-split-layout-tenants-block-the-controller-upgrade)
says how to tell. This page moves each tenant to the shared layout before the
[control-plane upgrade](production-upgrade.md#upgrade-the-control-plane). Adopt
in place where you can; use the export fallback for tenants that can't be
adopted.

## Adopt in place

Each `oce-gateways-<hash>` namespace becomes its tenant's namespace. OCC's database is not changed, so IDs, Namespace names,
revisions, Secrets, service-account credentials, chat history and Harness
workspaces all stay. The old namespace's workspace and embedded Gateway claims
move into it by PersistentVolume rebind, and its Agent Secrets are copied.

In a three-tenant test, the moves took about 20 seconds and the old API started
again in about 20 more; each helper release then stopped the API for about 20
seconds. `apply` also waits for the old Pods to stop, up to 5.5 minutes for a
Gateway that is not ready, so stop such Agents first. Dedicated Gateways keep
serving until they are deployed again; Harnesses and embedded Gateways are down
from `apply` until then. Run the commands from a checkout of the target
release, with cluster-admin `kubectl` for the cluster (`--context`/`--kubeconfig`
are passed through).

1. Plan. This only reads:

   ```bash
   node scripts/split-layout-adopt.mjs plan --out /secure/occ/adopt-plan.json
   ```

   It lists, per tenant, the claims, Secrets and routes to move and the Agents
   that run. It exits `2` and names the problem when a tenant can't be adopted:
   an existing namespace selected with `existingNamespace`, an object OCE did
   not create in the old namespace, a name taken in the new one, or a missing
   [tenant RoleBinding](production-agents.md#grant-tenant-rolebindings) in the
   `oce-gateways-*` namespace. Grant the bindings there, move or delete foreign
   objects (`--drop-resource <resource>`, as the refusal names it, deletes a
   kind you checked is disposable), or use the fallback below for that tenant
   (`--namespace-id` selects tenants). Codex OAuth sign-ins are bound to the
   old claim, so plan refuses those Agents unless you pass
   `--accept-oauth-reconnect`. Their deploy in step 5 then fails until someone
   connects again, and the new sign-in clears the Agent's Codex home, including
   its earlier sessions; the export fallback loses those too.

2. Back up the volumes the plan lists with your storage's snapshot or backup
   tool. The script does not back them up.
3. Adopt. This stops OCC's API and worker and the old namespace's workloads,
   moves everything, then starts the old API again for the upgrade helper. The
   worker stays stopped:

   ```bash
   node scripts/split-layout-adopt.mjs apply --archive /secure/occ/adopt --yes
   ```

   It records each step on the `oce-gateways-*` namespace, so running it again
   after any failure continues. Until step 4 starts the new release,
   `revert --archive /secure/occ/adopt --yes` restores the old layout and
   restarts OCC. With `--namespace-id`, revert restores only those tenants and
   restarts the old API; the worker stays stopped until the rest are reverted
   or the new release starts. Keep the archive directory: it holds the old
   routes. Adopt every tenant before the upgrade: once the controller runs
   other images, `apply` refuses.

   `apply` returns once the old API serves. Use it only for the upgrade
   helper: requests that touch an adopted tenant's Secrets, Configurations or
   Gateways fail with an ownership error until the new release starts, and
   Agent deploys wait for the new worker.

4. [Upgrade the control plane](production-upgrade.md#upgrade-the-control-plane)
   and the runtime as usual.
5. Deploy each Agent `apply` listed as running (`occ agent deploy <id>`) that is
   not running yet, and check it. A Gateway from the 2026-09-28 release
   migrates its agent database at its first start, about 15 seconds longer.
   If one stops with `uses schema version 23`, see the
   [notice](breaking-changes.md#2026-10-09-released-gateways-need-an-agent-database-migration).
6. Delete the old namespaces. After this there is no way back:

   ```bash
   node scripts/split-layout-adopt.mjs finalize --yes
   ```

   It refuses while the controller still runs the images `apply` recorded,
   and while the old namespace holds anything that would be lost with it.

## Export and re-create

Use this for tenants that can't be adopted.

The tenants are exported, deleted and re-created under new
IDs. A deleted Namespace's name stays
reserved, so each Namespace comes back under a new name. These come back:
Secrets (you supply the values again), Configurations that an Agent uses,
Presets, credential sources, Roles, access bindings, service accounts (without
issued credentials) and Agents. Agents that were running are deployed again,
and a copy of each running Agent's Harness workspace can be put back. These do
not come back:

- chat history and other Gateway state (the copy keeps the transcripts for
  reference; loading them into the new Gateway is untested);
- Agent revision history and bindings to old revisions;
- group, Installation-wide and resource-less bindings (re-create them by hand);
- issued service-account credentials and Agent runtime credentials;
- the old IDs and Namespace names, so update anything outside OCE that uses them.

Accounts, Installation service keys and the audit history stay in the database.

Tested on a 2026-09-28 release Installation with three Namespaces
and three Agents: the commands took about two minutes, plus the two image
releases (about 35 seconds each). Run them from a checkout of the target
release, with `occ` set up for the old release as an administrator (`OCC_URL`,
`OCC_SERVICE_KEY_FILE`, `OCC_CA_BUNDLE`) and `kubectl` for the cluster. The
script talks to OCC only. Keep every file below private: they hold
Configurations, workspace files, transcripts and Secret values.

1. Export every Namespace from the old release:

   ```bash
   node scripts/split-layout-tenants.mjs export --out /secure/occ/tenants.json
   ```

   If a successful API response is malformed or lacks its data envelope, export
   exits nonzero without writing a bundle. Restore the API response path and
   rerun export, then check its Namespace inventory before continuing.

   It reads `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md` only where
   [workspace routing](workspace-routing.md) is configured and the Agent runs.
   Step 2 copies the whole workspace instead.

2. Copy each running Agent's Harness workspace and Gateway state:

   ```bash
   ARCHIVE=/secure/occ/tenant-archive
   mkdir -m 700 -p "$ARCHIVE"
   kubectl get pods -A -l openclaw.dev/agent --field-selector status.phase=Running -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.name} {.metadata.labels.openclaw\.dev/workload-role} {.metadata.labels.openclaw\.dev/agent}{"\n"}{end}' |
   while read -r ns pod role agent; do
     case $role in
       gateway) paths='.openclaw/state .openclaw/agents/main/agent .openclaw/media .openclaw/agents/main/sessions' ;;
       agent) paths='workspace .codex/generated_images' ;;
       *) continue ;;
     esac
     kubectl -n "$ns" exec "$pod" -c "$role" -- tar -C /home/node --ignore-failed-read \
       --exclude=codex-home --exclude='.oce-workspace-setup.*' -cf - $paths \
       >"$ARCHIVE/$agent-$role.tar" </dev/null || echo "failed: $agent $role"
   done
   ```

3. Write the Secret values to a `0600` file such as
   `/secure/occ/tenant-secrets.json`, keyed by the old Namespace name, then
   Secret name: `{"team-a": {"model-key": "..."}}`. List the names with
   `jq '.namespaces[] | {name, secrets: [.secrets[].name]}' /secure/occ/tenants.json`.
4. Delete the tenants on the old release. The command refuses if a Namespace
   gained an Agent or Secret after the export, or if the export could not read an
   Agent's workspace files; once step 2 has the copy, add
   `--allow-unread-workspace-files`:

   ```bash
   node scripts/split-layout-tenants.mjs discard --bundle /secure/occ/tenants.json \
     --yes --allow-unread-workspace-files
   kubectl get namespaces -l openclaw.dev/gateway-namespace
   ```

   Continue when no `oce-gateways-*` namespace is left. A Configuration that no
   Agent uses is not exported and blocks its Namespace's delete; the error says
   how to find and delete it. Then run `discard` again.

5. [Upgrade the control plane](production-upgrade.md#upgrade-the-control-plane)
   and the runtime as usual. The preflight now passes.
6. Re-create the tenants under new Namespace names. `--skip` leaves out a
   Namespace you no longer need, such as an unused `default`:

   ```bash
   node scripts/split-layout-tenants.mjs import --bundle /secure/occ/tenants.json \
     --secret-values /secure/occ/tenant-secrets.json --map /secure/occ/tenant-ids.json \
     --rename team-a=team-a-2 --skip default
   ```

   It creates the Namespaces and exits `3` until they are `ready`.
   [Grant tenant RoleBindings](production-agents.md#grant-tenant-rolebindings)
   for each one, then run the same command again. The ID map records every old
   and new ID, so a rerun after any failure resumes. Exit `4` lists what needs a
   hand: Agents whose deploy failed, such as a service-account Agent without an
   issued credential, and access bindings it could not re-create.

7. Put each Harness workspace back once the new Agent's Harness Pod runs:

   ```bash
   for tarball in "$ARCHIVE"/*-agent.tar; do
     old=$(basename "$tarball" -agent.tar)
     new=$(jq -r --arg old "$old" '.ids[$old] // empty' /secure/occ/tenant-ids.json)
     [ -n "$new" ] || { echo "skipped: $old was not imported"; continue; }
     read -r ns pod < <(kubectl get pods -A --field-selector status.phase=Running \
       -l "openclaw.dev/agent=$new,openclaw.dev/workload-role=agent" \
       -o jsonpath='{.items[0].metadata.namespace} {.items[0].metadata.name}')
     [ -n "${pod:-}" ] || { echo "skipped: $new has no running Harness"; continue; }
     kubectl -n "$ns" exec -i "$pod" -c agent -- tar -C /home/node --no-overwrite-dir -xf - <"$tarball" \
       && echo "restored $old -> $new" || echo "failed: $old -> $new"
   done
   ```

8. Check the Agents (`occ agent list`) and re-issue any service-account
   credentials.
