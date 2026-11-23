# Plan an OpenClaw Enterprise upgrade

Use this checklist before changing an OpenClaw Enterprise (OCE) controller,
runtime, Helm chart, or Installation configuration in an environment that must
retain data. It inventories the state an image update does not change by itself.

The checklist complements the
[production image upgrade procedure](production-upgrade.md) and the
[persistent local k3d procedure](local-k3d-image-upgrade.md). A custom retained
Compose or Compose-and-k3d environment has no supported in-place upgrade
command; use this page as its migration inventory.

## Classify the release

- [ ] Record the candidate OCE source commit, upstream OpenClaw commit, Codex
      version, configured image references, and immutable controller and runtime
      image digests. Confirm the build source was clean, recorded, and includes
      this release's required changes. Do not use a moving tag or a configured
      reference alone as upgrade evidence.
- [ ] Diff the deployed and candidate source for database migrations, Helm
      templates, Installation schema, bundled Presets, Driver settings, runtime
      dependencies, and required Kubernetes assets.
- [ ] Check that the candidate can read each Installation `presets.files` path.
      Restore required files. Flag obsolete entries. Ordinary image upgrades
      permit only supported Plugin Driver Installation edits.
- [ ] For single-cluster discovery, run
      `kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' get namespaces -l 'openclaw.dev/gateway-namespace,!openclaw.dev/namespace' -L openclaw.dev/gateway-namespace`.
      Require a complete, successful read. For
      [split tenants](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations),
      the tenant label is absent and the namespace name matches the storage name
      derived from a nonempty Gateway label.
- [ ] With [preprovisioning](../../reference/drivers/kubernetes-compute/preprovisioned-namespace.md),
      verify the bound Namespace. Stop here. This profile omits initialization Jobs
      and requires an independently migrated database and bootstrapped Installation.
- [ ] Render with live values (`helm template --is-upgrade`) and
      [correct refused values](production-upgrade-recovery.md#correct-values-the-candidate-refuses)
      before maintenance. Preflight rejects missing Preset files and
      single-cluster split layouts before stopping writers.
- [ ] Identify changed controller, repository broker and runtime images.
      The new worker can restart Agent Pods once, interrupting
      repository-bound versions. Runtime upgrades create versions from current
      Agent and Configuration drafts. Trace inputs through intermediate stages
      (`COPY --from=`) into the final `runtime` stage.
      See `grep -nE '^(FROM|COPY)' deploy/runtime/Dockerfile`.
      Rebuild the runtime when inputs, the OpenClaw commit or Codex version
      change. Inputs include
      `apps/controller/src/drivers/repo/github/access/client/` and
      `apps/controller/src/drivers/repo/access/client-contracts.ts`.
      The controller renders Agent Pod specs using files such
      as `apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts`:
      existing Agents get that change when the controller renders their Pods again.
- [ ] Check controller/runtime compatibility. Upgrade the controller first when
      it supports the deployed runtime. Use a release-specific sequence when the
      versions cannot run together.
- [ ] [Check operator access](#check-operator-access) while the incumbent serves traffic.
- [ ] Freeze concurrent Helm changes, disable OCC autoscalers and restart automation,
      and stop all other database writers through recovery. Freeze Agent deployments
      and settle existing deployment work for every release; also freeze draft edits
      for runtime releases.

### Check operator access

Use the upgrade's OCC CLI, endpoint, CA and protected key file. Check the
issuance record's expiry, if present, against the planned upgrade and recovery
window. Before freezing writers, verify the Installation ID and fleet access.
Set `BASELINE` to the intended release's
[baseline directory](upgrade-baseline.md#record-the-release-and-its-configuration).

```bash
(
  set -euo pipefail
  installation_id=$(jq -er '.installationId | strings | select(length > 0)' \
    "${BASELINE:?}/installation-secret.json")
  /secure/occ/bin/occ --output json installation get |
    jq -es --arg id "$installation_id" 'length == 1 and .[0].id == $id' >/dev/null
  /secure/occ/bin/occ --output json installation deployment-inventory |
    jq -es --arg id "$installation_id" \
      'length == 1 and .[0].installationId == $id and (.[0].namespaces | type == "array")' >/dev/null
)
```

Continue on exit zero, including for an empty fleet. If OCC rejects the key,
obtain a current key from the Installation administrator and repeat both reads.
For permission failures, check the [inventory grants](upgrade-baseline.md#record-the-occ-inventory).
Resolve target or connection errors before maintenance. The helper rechecks the
inventory before stopping writers.

### Check ReplicaSet capacity

Plan capacity before Helm or stopping workloads. For planning or a stalled
rollout, use Bash with the release's kubeconfig, context and namespace. Set the
affected Deployment name.

```bash
kube=(kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>'
  --namespace '<release-namespace>')
deployment=openclaw-enterprise-api # repeat for openclaw-enterprise-worker
"${kube[@]}" get resourcequota -o yaml
"${kube[@]}" get replicasets
"${kube[@]}" describe deployment "$deployment"
"${kube[@]}" get events --field-selector "involvedObject.kind=Deployment,involvedObject.name=$deployment" \
  --sort-by=.metadata.creationTimestamp
```

These commands are read-only. A condition or event naming the affected
Deployment and reporting `exceeded quota` for `count/replicasets.apps` during
this rollout identifies the cause. A full quota alone does not. Reason names
vary, and events expire.

For `count/replicasets.apps`, inspect each quota's `spec.hard`, `status.hard`
and `status.used`. A limit is absent only after a successful full list shows
none configured for this resource. Capacity is unknown if reads fail or an
applicable status is missing or has not caught up with the configured limit.
Ask the namespace owner to resolve uncertainty without adding privileges.
Compare each limit independently against namespace usage plus needed slots.
Room under these limits does not guarantee other admission checks will pass.

The unfiltered ReplicaSet list includes current sets, retained history and other
releases, even with zero replicas. Before Helm, compare each **candidate** Pod
template rendered with the target values against the Deployment's owned sets.
Allow for target admission defaults and mutations. Reserve a slot for each
concurrent rollout unless its resulting template is known to match an owned
set. If admission is uncertain, reserve the slot. The live Deployment still
describes the old release and cannot establish a match for the candidate.

After Helm submits the candidate, inspect the live `spec.template` and
`revisionHistoryLimit` with `"${kube[@]}" get deployment "$deployment" -o yaml`.
Compare the template with `"${kube[@]}" get replicaset '<set-name>' -o yaml`.
Check owner UIDs and ignore the generated `pod-template-hash` label. Scaling or
a generation change alone does not require a new set. Preserve history; do not
count on cleanup before creation.

If room is insufficient, ask the namespace owner for object capacity. After
recovery, confirm rollout completion, Ready Pods and expected running `imageID`
values when checking manually. Do not replay Helm or delete history or data.
Follow [upgrade recovery](production-upgrade-recovery.md) and preserve any
existing helper or rollback owner's control.

### Check Job object capacity

For releases that create Jobs, check capacity before Helm. Reuse the Bash
`kube` array above with the reviewed context and each namespace that receives
Jobs. Use these read-only commands.

```bash
"${kube[@]}" get resourcequota -o yaml
"${kube[@]}" get jobs.batch
"${kube[@]}" get events --sort-by=.metadata.creationTimestamp
```

Apply the quota rules above for failed reads, absent limits, missing or stale
status, and multiple quotas. For each applicable `count/jobs.batch` quota,
check `spec.hard`, `status.hard` and `status.used`. Add the release's peak number
of additional Job objects that can exist at once to `status.used`. The sum must
fit within `status.hard`. Existing usage includes retained completed and failed
Jobs. Include new Jobs that remain after completion or failure in the peak.
Plan without relying on cleanup before creation. For example, a quota with a hard limit of 12
and a used count of 9 leaves room for 3 Jobs. A release that needs 4 additional
Jobs at once exceeds that limit. Ask the namespace owner about insufficient
capacity.
See Kubernetes [object count quota](https://kubernetes.io/docs/concepts/policy/resource-quotas/#quota-on-object-count).

A successful server dry run of one request reserves no capacity. Diagnose a
quota refusal from the Kubernetes API's rejection of the Job creation request
naming `count/jobs.batch`, or a corresponding controller event recording that
rejection. Observing a full quota alone does not prove a creation request was
refused. Events can expire, and other admission checks can still reject creation.

## Record the starting state

Create a private evidence directory and record these values before mutation.
[The pre-upgrade baseline](upgrade-baseline.md) gives commands for many:

- [ ] OCC Installation ID, cluster/context, Helm release or Compose project,
      source commit, chart revision, and all running image digests.
- [ ] Protected Helm values and Installation YAML, plus the live rendered values
      and mounted Installation Secret or file. Resolve unexplained drift first.
- [ ] Database migration catalog and receipts. Back up PostgreSQL when
      recovery could require restoring control-plane data.
- [ ] Namespace, Agent, Configuration, Preset, Secret metadata, IAM Role,
      AccessBinding, Backend, service account, selected version, desired state,
      deployment work, and audit-record inventories. Never record Secret values.
- [ ] Kubernetes Namespace labels, RoleBindings, Services, NetworkPolicies,
      Gateway resources, storage classes, seccomp profiles, and supporting
      controller or sidecar versions.
- [ ] PVC names and UIDs, PV names, representative workspace file hashes,
      session counts, and gateway state. Back up volumes when recovery could
      require restoring Agent data. For a streamed backup, compare source and
      destination byte counts and SHA-256 digests for the same archive, and
      confirm that the producer completed successfully. A zero exit status alone
      does not prove that the full archive arrived. After an interruption, accept
      the backup only if both byte counts match, both SHA-256 digests match, and
      the producer completed successfully. Otherwise, retain the partial output
      and diagnostics.
- [ ] When recovery needs data from multiple stores, capture the required stores
      at one consistent point. Include the selected Configuration Driver's
      backing store when recovery needs current Configuration values. For the
      Kubernetes Driver, capture the
      [Configuration ConfigMaps](../../reference/configuration/kubernetes.md)
      in their tenant storage namespaces using existing authorized access.
      Pause all relevant writers throughout capture, or use storage tooling
      that guarantees consistency across those stores. A PostgreSQL recovery
      window spanning two disk snapshots does not prove their contents agree.
      Before booking downtime, restore the database, Gateway state, workspaces,
      and any required Configuration values together on an isolated copy.
      Before starting restored services, block production traffic and outbound
      access to production repository, channel, and model providers. A restored
      worker can otherwise revoke credentials still in use or send live
      deliveries. Use isolated test endpoints and credentials for checks that
      need a provider. If you restored Configuration values, read a known saved
      Configuration through the restored application by its exact Namespace and
      Configuration IDs. Compare its generation and a representative nonsecret
      value with the source baseline. Through the same application, verify a
      known Agent revision and compare a nonsecret setting with that revision's
      baseline. PostgreSQL stores the revision's immutable configuration
      snapshot, which can differ from the current draft. Do not print or record
      sensitive Configuration or Secret material. Reopen an existing session
      and check a known workspace file. Record the recovery time.
- [ ] Authentication origin, cookie domain, auth-secret identity, TLS material,
      bootstrap key storage, service-principal and service-key identities,
      repository registry metadata, broker sessions, and external provider or
      channel grants.
- [ ] If CredentialSources are enabled, inventory their IDs, status, bindings,
      and selected Gateway. Record recovery and rotation procedures for the
      Gateway's separately managed provider credentials without recording values.
      Updating a Namespace Secret does not update the Gateway's copy. See the
      [CredentialSource reference](../../reference/credential-sources.md) for
      the OpenShell Gateway's production limitations.
- [ ] Compare Agent drafts and persisted Preset plugin policies with the
      candidate's [plugin policy contract](../../reference/agent-plugins.md).
      Resolve unsupported approval fields or values deliberately. Verify
      intended reviewer and approval behavior
      before deploying those drafts.
- [ ] If the dedicated Codex Localhost seccomp profile is used, verify its
      artifact and sandbox probe on every eligible node, including replacement
      nodes. Reassess it when the node or runtime inputs change; follow the
      [Codex sandbox procedure](codex-sandbox.md).
- [ ] Before restarting or replacing enabled brokers, inspect sessions and cleanup.
      `CLOSED`, missing inventory and `invalidated` attempts do not establish
      `DISPOSED`. Retain unresolved cleanup evidence and follow
      [broker recovery](../repository-credentials/installation.md#install-and-verify).
      Plan interruptions for running Agents with delivered sessions, including
      controller-only upgrades. Review drafts and deploy grants for
      separately authorized replacements. Stop if authorized recovery is infeasible.

## Assign every surface a disposition

Give every surface the disposition and operator action listed in
[upgrade surface dispositions](upgrade-dispositions.md), from controller images
and database migrations to retained volumes and local profile state.

## Apply the release in dependency order

1. Install cluster prerequisites (upgrade the
   [execution chart](../../testing/kubernetes.md#upgrade-the-execution-chart)
   first on two clusters). Reconcile protected inputs without replacing retained data.
   Continue to step 2 unless removing obsolete `presets.files` entries.
   Stop for immutable Installation Secrets. Seek separate review. Before editing, require
   `repositoryWorkerRestart` of `not-applicable` or `reverification-supported`
   for every retained running revision in the incumbent’s complete deployment inventory. Otherwise stop.
   After baseline capture and broker recovery planning, [remove obsolete entries](production-installation-changes.md)
   and restart API and worker. Preserve saved Presets and grants. Verify recovery against
   the unchanged original baseline. Reconcile protected and live inputs.
   Capture another complete baseline elsewhere. Set `BASELINE` there.
2. Run the [upgrade preflight](production-upgrade.md#rehearse-before-the-maintenance-window),
   including the candidate's canonical migration check. Stop on unsupported
   history or an unresolved required quiescence step.
3. Upgrade the controller, worker, and Console. The API Pod’s
   [30-second grace period](../../flows/production-startup.md#4-start-private-api-and-worker-deployments)
   can expire mid-request. Keep the freeze through recovery. After forced or
   uncertain shutdown, have the database owner confirm that old transactions
   have ended before proceeding. Neither Pod removal nor migration checks prove
   this. Verify migration, bootstrap, authenticated API recovery, and worker
   readiness.
4. Reconcile persisted resources that startup intentionally preserves, including
   same-name Presets. Compare complete objects, not only counts or names.
5. For ordinary runtime image changes, update selections, reload API and worker,
   and deploy recorded running Agents through OCC. Skip completed helper actions.
   Reconcile unknown effects first.
   Handle authorized broker recovery separately.
   [One-off upgrades](one-off-upgrades.md) can require redeployment with unchanged
   runtime images.
6. Reconcile external integrations and cluster-owned supporting services.
7. Run the acceptance checks below before ending the interruption window.

## Verify the retained installation

- [ ] The [debug](../../reference/console/debug-fields.md) Console **OCE commit**
      matches the candidate's `OCC_BUILD_REVISION`. API and worker run the
      expected controller digest; migration history is canonical.
- [ ] The authenticated Installation and protected startup configuration agree.
      API and worker selected the same Driver identities.
- [ ] Namespace, Agent, Configuration, Preset and Secret-metadata inventories
      retain expected `BASELINE` IDs. Reconcile IAM, Backend, service-account,
      deployment-work and audit-record inventories with `BASELINE`. Ordinary
      controller-only upgrades request no deployments. Verify restarted Pods
      are ready. Verify Agent revisions replaced for broker recovery.
- [ ] Persisted Preset templates match the intended source definitions. Missing
      defaults were created, intended same-name copies were updated in place,
      and obsolete copies were handled deliberately.
- [ ] Runtime releases selected new successful versions. Gateway and Agent Pods
      are ready on the requested digest; stopped Agents were not started.
- [ ] PVC and PV identities, workspace hashes, gateway state, and representative
      sessions match `BASELINE`.
- [ ] The configured sign-in paths work and expected operations appear in the
      audit ledger. Check that configured metrics, traces, and test alerts
      reach their destinations.
- [ ] For each execution mode and provider in use, verify the expected Agent
      revision, allowed and denied gateway access, and a fresh reply from the
      intended model provider.
      For manual checks, follow [production workload verification](production-agents.md#verify-production-workloads).
- [ ] Run a representative request for each workflow in use and
      check its result at the destination. Include relevant channel delivery,
      repository clone or write, plugin tool policy, workspace access, and
      native admin UI. For installed integrations, verify negotiated
      capabilities through the authenticated connection, then verify the
      downstream operation. Where plugin approval is required, verify approval
      and denial through the intended reviewer. See
      [workflow verification](production-handoff.md#verify-the-deployed-workflow).
- [ ] Where CredentialSources are enabled, confirm source status and Agent
      bindings and verify a real model reply through the selected Gateway.
- [ ] Evidence contains the before/after inventory, rendered configuration,
      migration receipt, rollout status, deployment results, and any accepted
      exceptions, but no credential values.

## Stop and recover safely

Stop before mutation when the source or image identity is unknown, protected and
live configuration differ unexpectedly, migration history is unsupported,
required backups are missing, deployment work is active, or a cluster-specific
override has no reviewed candidate equivalent.

After a controller failure, inspect migration and bootstrap results before
considering rollback. Do not run an older controller against state it cannot
read. After a partial runtime failure, keep the healthy control plane and recover
the affected Agents individually. Never delete persistent resources to make the
upgrade appear clean.

If the candidate accepted writes, preserve them before restoring older data and
reconcile them before reopening traffic, or repair the candidate in place.

## Related guides

- [Upgrade production images](production-upgrade.md)
- [Upgrade images on a persistent local k3d installation](local-k3d-image-upgrade.md)
- [Local Kubernetes development](local-kubernetes-development.md)
- [Install the production control plane](production-installation.md)
- [Deploy and verify production Agents](production-agents.md)
- [Preset behavior](../../reference/presets.md)
- [Production upgrade flow](../../flows/coordinated-production-upgrade.md)
