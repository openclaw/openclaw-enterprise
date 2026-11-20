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

`discard` deletes every tenant in the bundle; `--skip` applies only to import.
Stop if any Namespace visible to the old API credentials must stay in place.

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
issued credentials) and Agents. Import attempts to deploy Agents that the bundle
records as running. Workspace recovery requires a verified backup for each
Agent workspace you need to keep. These do not come back:

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

Pause user, automation and Agent writes to affected tenant resources, including
Configurations, workspaces and Gateway state. Drain queued and in-flight writes;
keep writers idle through discard. Pause replacement-tenant user and automation
writes through restore verification. Keep the old API and worker ready and retain
Kubernetes, Pod and storage access. Record each Agent's run state before stopping it.

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
   These four files are only a partial copy of a workspace.

2. For each bundled OCC Namespace and Agent ID, verify the Installation,
   Kubernetes context and namespace, workspace directory and volume through
   deployment and storage records. Labels alone do not prove ownership. Stop on
   missing, duplicate or mismatched identities. With writers idle, take a
   supported storage backup of **each Agent's workspace volume**, including
   stopped dedicated and embedded Agents. Record source-to-backup mappings. Use
   new operator-only locations (`0700` directories, `0600` files) outside
   resources `discard` deletes; do not overwrite existing copies.

   Separately capture listed data outside the workspace volume that you need.
   For Pod copies, verify ownership, UID, role, container and mount; bind capture
   to that resource or use scoped storage backup. Paths are relative to `/home/node`:

   | Role                        | Data paths                                                                                            |
   | --------------------------- | ----------------------------------------------------------------------------------------------------- |
   | Dedicated Harness (`agent`) | `workspace`, `.codex/generated_images`                                                                |
   | Gateway (`gateway`)         | `.openclaw/state`, `.openclaw/agents/main/agent`, `.openclaw/media`, `.openclaw/agents/main/sessions` |

   Exclude `codex-home` and `.oce-workspace-setup.*` from Pod copies. A Gateway
   copy omits the embedded workspace. Require listing, backup and capture
   failures to reach the operator. Stop on failure or uncertainty; keep partial
   output private and exclude it from restore.

3. Write the Secret values to a `0600` file such as
   `/secure/occ/tenant-secrets.json`, keyed by the old Namespace name, then
   Secret name: `{"team-a": {"model-key": "..."}}`. List the names with
   `jq '.namespaces[] | {name, secrets: [.secrets[].name]}' /secure/occ/tenants.json`.
4. Before `discard`, confirm writers remain idle and the bundle's Namespace
   names and IDs still match the intended tenants. If a writer resumed, quiesce
   it and repeat export, backup, capture and verification. The command refuses ambiguous source IDs and
   Namespaces that gained an Agent or Secret absent from the bundle.

   For **each bundled Agent**, restore the workspace storage backup to an
   isolated destination and record its identity. Inventory the entire idle source
   and isolated restore, including hidden and nested entries. Require both
   inventories to be complete and their relative paths and entry types to match
   in both directions: stop on any missing or extra entry. For every matching
   entry, compare file contents, symbolic-link targets, ownership, permission
   modes, executable bits and other required metadata. Stop on any mismatch or
   uncertainty before discard. Apply the same complete, bidirectional comparison
   to each separately captured path selected in step 2, including required
   dedicated Harness `.codex/generated_images` and Gateway data. Compare each
   idle source with its copy; stop on any discrepancy or uncertainty. Keep
   deliberate exclusions and unneeded optional data outside scope. Plan to import the Namespace and Agent for every workspace you will
   restore. Successful commands and the four exported files do not prove
   completeness.

   If export could not read workspace files, recover them and export again.
   Use `--allow-unread-workspace-files` only after verifying a separate copy of
   those files for each affected Agent; it does not replace the complete backup.
   If any identity, backup or isolated restore is incomplete, failed or
   uncertain, **stop before discard**. Keep the tenants and volumes; Operations
   must decide recovery before deletion can proceed.

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

7. Map both old IDs to the new OCC Namespace and Agent; verify their relationship.
   Use deployment and storage records to verify the Installation, Kubernetes
   context and namespace, workspace directory and destination volume. Provision
   and verify missing volumes. For Pod restores, verify ownership, UID, role,
   container and mount; bind the operation to that resource. Stop on a missing,
   duplicate or mismatched target. Record each backup-to-destination mapping.

   Quiesce destination writers, including Agents started by import. Inventory
   the existing destination and compare it with the verified backup. Preserve
   outside the target anything restore could overwrite or remove, including
   import writes and conflicting versions of the four exported files. Record
   each conflict's disposition and preserve documented ownership; do not blindly
   delete or overwrite destination paths. The four-file export override does not
   authorize resolving these conflicts. If writers cannot be quiesced or
   conflicts remain, stop; Operations decides the recovery action before restore.

   Restore each mapped workspace with the scoped procedure proven in step 4.
   On failure or uncertain effect, stop, preserve the backup, and have Operations
   reconcile the indeterminate destination before retry. Before resuming writers,
   inventory the entire mapped destination, including hidden and nested entries.
   Require complete inventories and compare every verified backup path in both
   directions against the destination, accounting separately for any explicitly
   retained destination-owned paths. Stop on missing or unexpected extra entries,
   type differences, content or link-target mismatches, or differences in required
   ownership, permission modes, executable bits or other metadata. Confirm that
   the normal runtime user can read and use the restored workspace. Resume only
   after all discrepancies are resolved.

8. After restore verification, return Agents to their prior run state using
   the new IDs. Check the Agents (`occ agent list`), re-issue any service-account
   credentials and resume user and automation writes.
