# Upgrade a split-layout Installation

Single-cluster Installations created by the 2026-09-28 release keep each
Namespace's Gateways, Gateway state and canonical Secrets in a separate
`oce-gateways-<hash>` namespace. The current controller refuses to start on that
layout; [split-layout installations](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations)
says how to tell. This page moves each tenant to the shared layout before the
[control-plane upgrade](production-upgrade.md#upgrade-the-control-plane).

Plan adoption for all split-layout tenants. Resolve refusals and rerun the
plan before you apply it. If any refusal remains, stop before adopting a subset.
Choose export and re-create only if you accept deletion and the recovery limits
for every Namespace the old API credentials can see. If any of those tenants
must stay in place, stop and agree on a recovery plan with your operations team.

## Adopt in place

Each `oce-gateways-<hash>` namespace becomes its tenant's namespace. OCC's database is not changed, so IDs, Namespace names,
versions, Secrets, service-account credentials, chat history and Harness
workspaces all stay. The old namespace's workspace and embedded Gateway claims
move into it by PersistentVolume rebind, and its Agent Secrets are copied.

In a three-tenant test, the moves took about 20 seconds and the old API started
again in about 20 more; each helper release then stopped the API for about 20
seconds. `apply` waits for old Pods to release their claims. Its wait budget
is five minutes plus the longest termination grace period of those Pods. Stop
unready Agents before adoption. Dedicated Gateways keep serving until they are
deployed again. Harnesses and embedded Gateways are down from `apply` until then. Run the commands from a checkout of the target
release. Use Node.js in the range specified by `engines.node` in
`package.json` (`>=24.22.1 <26 || >=26.12.1`). Use a `kubectl` identity with
cluster-admin access. Use the same cluster for each command. Select it with
`--context` or `--kubeconfig`. If OCC runs outside `openclaw-system`, set
`--occ-namespace` for `apply`, `revert` and `finalize`.

1. Plan without changing the cluster. Create the private output directory
   before you write the plan:

   ```bash
   node scripts/split-layout-adopt.ts plan --out /secure/occ/adopt-plan.json
   ```

   The plan file lists each tenant's claims, Secrets, routes and running
   Agents. The command exits `2` and names any adoption refusals, such as
   an existing namespace selected with `existingNamespace`, an object OCE did
   not create in the old namespace, a name taken in the new one, or a missing
   [tenant RoleBinding](production-agents.md#grant-tenant-rolebindings) in the
   `oce-gateways-*` namespace. Grant the bindings there, and move or delete
   foreign objects. Use `--drop-resource <resource>` only for kinds you can
   lose when `finalize` deletes the old namespace. Use `--namespace-id` for
   inspection only in this procedure. If the plan reports a previous adoption,
   check its journal state before you continue. Codex OAuth sign-ins are bound
   to the old claim. The plan refuses those Agents unless you pass
   `--accept-oauth-reconnect`. Their deploy in
   step 5 then fails until someone connects again. The new sign-in clears
   the Agent's Codex home, including its earlier sessions. Export and
   re-create also loses those sessions.

2. Back up the volumes the plan lists with your storage's snapshot or backup
   tool. The script does not back them up.
3. Adopt all split-layout tenants. Use a private archive directory (mode
   0700). Repeat any accepted `--accept-oauth-reconnect` and
   `--drop-resource` options from the plan. Adoption stops the API and worker,
   then scales down deployments in the old tenant namespaces. It moves the
   planned resources and starts the old API for the upgrade helper. The worker
   stays stopped.

   ```bash
   node scripts/split-layout-adopt.ts apply --archive /secure/occ/adopt --yes
   ```

   Adoption records progress on the `oce-gateways-*` namespaces. If `apply`
   fails or is interrupted, stop. Reconcile the journals and the live state
   with your operations team before retrying, reverting or upgrading.

   To undo a completed adoption before the upgrade starts the new release, run
   `revert` with the same archive. Both deployments must still use the
   images recorded by `apply`:

   ```bash
   node scripts/split-layout-adopt.ts revert --archive /secure/occ/adopt --yes
   ```

   Keep the archive. It holds the old routes. With `--namespace-id`, `revert`
   selects only those tenants. While any adoption journals remain, it
   starts only the old API. When the last journal is removed, it restores the
   recorded replica counts for both deployments. Verify that the old layout and
   both deployments are healthy before resuming operations.

   Verify that the old API is serving before you run the upgrade helper.
   Use the API only for that helper. Requests for an adopted tenant's Secrets,
   Configurations or Gateways fail with an ownership error until the new
   release starts. Agent deploys wait for the new worker.

4. After `apply` succeeds for every split-layout tenant,
   [upgrade the control plane](production-upgrade.md#upgrade-the-control-plane)
   and the runtime as usual.
5. Deploy each Agent `apply` listed as running (`occ agent deploy <id>`) that is
   not running yet, and check it. A Gateway from the 2026-09-28 release
   migrates its agent database at its first start, about 15 seconds longer.
6. Delete the old namespaces. After deletion, `revert` cannot restore them:

   ```bash
   node scripts/split-layout-adopt.ts finalize --yes
   ```

   The command refuses while either deployment still uses the images that
   `apply` recorded. It checks for remaining claims, unexpected resources and
   unbound moved claims before it deletes an old namespace.

## Export and re-create

Before you export, decide whether you can delete and re-create every Namespace
visible to the old API credentials. `discard` deletes the tenants in the entire
bundle. `--skip` applies only to import. If any of those tenants must stay in
place, stop and agree on a recovery plan with your operations team.

If you have a completed adoption, follow the revert instructions above for
all affected tenants before you export. If `apply` or `revert` failed, was
interrupted, or left an uncertain state, stop and reconcile it with your
operations team before using this procedure. Verify that the old tenant layout is in place and that
both the old API and worker are ready. `discard` needs the worker to finish
deleting Agents.

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
- Agent revision history and bindings to old versions;
- group, Installation-wide and resource-less bindings (re-create them by hand);
- issued service-account credentials and Agent runtime credentials;
- the old IDs and Namespace names, so update anything outside OCE that uses them.

Accounts, Installation service keys and the audit history stay in the database.

Tested on a 2026-09-28 release Installation with three Namespaces
and three Agents: the commands took about two minutes, plus the two image
releases (about 35 seconds each). Use the target release checkout and Node.js
version described above. Configure `occ` for the old release as an administrator
with `OCC_URL` and `OCC_SERVICE_KEY_FILE`. Set `OCC_CA_BUNDLE` if the API uses
a custom CA. Point `kubectl` at the same Installation's cluster. Keep all
output private. The files hold Configurations, workspace files, transcripts
and Secret values.

1. Export every Namespace visible to the old API credentials. Use a new
   output file:

   ```bash
   node scripts/split-layout-tenants.ts export --out /secure/occ/tenants.json
   ```

   If a successful API response is malformed, lacks required restoration fields,
   or reports unreadable saved Agent settings, export
   exits nonzero without writing a bundle. Restore the API response path and
   rerun export. Check the new bundle's Namespace names and IDs against the
   tenants you intend to delete before continuing.

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
4. Before you run `discard`, confirm that the bundle's Namespace names and IDs
   still match the tenants you intend to delete. Verify the contents of the
   workspace copies you need from step 2. The command refuses ambiguous source
   IDs that the import map cannot represent. It also refuses if a Namespace in the bundle
   gained an Agent or Secret that the bundle lacks. If export could not read
   workspace files, recover them and export again. Use
   `--allow-unread-workspace-files` only if you have verified a separate copy
   of those files for each affected Agent.

   ```bash
   node scripts/split-layout-tenants.ts discard --bundle /secure/occ/tenants.json --yes &&
     kubectl get namespaces -l openclaw.dev/gateway-namespace
   ```

   If `discard` times out or reports an uncertain write, reconcile which
   deletions started or completed before you retry. A Configuration that no Agent uses can block its
   Namespace's deletion after Agents and other resources have been deleted.
   The error explains how to find it. Preserve anything you need before you
   delete the unused Configuration and resume `discard`.

5. After `discard` succeeds and no `oce-gateways-*` namespace remains,
   [upgrade the control plane](production-upgrade.md#upgrade-the-control-plane)
   and the runtime as usual.
6. Re-create the tenants under new Namespace names. `--skip` leaves out a
   Namespace you no longer need, such as an unused `default`:

   ```bash
   node scripts/split-layout-tenants.ts import --bundle /secure/occ/tenants.json \
     --secret-values /secure/occ/tenant-secrets.json --map /secure/occ/tenant-ids.json \
     --rename team-a=team-a-2 --skip default
   ```

   Give each selected source Namespace a distinct target name. Import refuses
   overlapping `--rename` targets or two selected sources that resolve to one
   Namespace through saved IDs or existing names, before it changes the target
   or saves the map. A skipped source without a saved destination reserves
   nothing; a saved destination stays reserved even while its source is skipped.
   Choose separate targets or skip a source; review an old conflicting map and
   any already imported resources before retrying. Malformed saved IDs and duplicate
   source Namespace IDs, including skipped sources, are refused before any API request.
   Import also refuses source IDs shared by different resource kinds or
   Namespaces, including skipped sources: its flat map cannot keep their destinations separate. Preserve the
   export and restore those colliding resources manually; do not alter IDs in the bundle.

   It creates the Namespaces and exits `3` while they are `provisioning`.
   [Grant tenant RoleBindings](production-agents.md#grant-tenant-rolebindings)
   for each one, then run the same command again. The ID map records every old
   and new ID. If a write's response has an unexpected status, resource identity,
   or success/error envelope, reconcile that write before resuming; it may already have committed. Redirects are refused: correct `OCC_URL` instead of replaying a write through a redirect. Failed or deleting Namespaces require
   lifecycle recovery, not another RoleBinding wait. Exit `4` lists what needs a
   hand: Agents whose deploy failed, such as a service-account Agent without an
   issued credential, and access bindings it could not re-create. The ID map does
   not record those bindings, so each rerun lists them again and exits `4`, also
   after you re-create them by hand. Exit `0` does not restore bindings to old
   Agent revisions; the import only logs them.

   Presets are restored after service-account IDs are mapped, so their Harness
   authentication refers to the restored account. Existing mapped Presets are
   left unchanged; inspect their account references before resuming an older
   import. See the [tenant restore flow](../../flows/tenant-restore.md).

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
