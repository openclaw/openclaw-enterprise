# Plan an OpenClaw Enterprise upgrade

Use this checklist to preserve data across controller, runtime, Helm chart, or
Installation changes. Follow the [production](production-upgrade.md) or
[persistent local k3d](local-k3d-image-upgrade.md) procedure. For custom
Compose or Compose-and-k3d environments, use the checklist as an inventory.
They have no supported in-place upgrade command.

## Classify the release

- [ ] Record the candidate OCE source commit, upstream OpenClaw commit, Codex
      version, configured image references, and immutable controller and runtime
      image digests. Verify the recorded build source was clean and includes
      the required changes. Tags alone do not identify the build.
- [ ] Diff the deployed and candidate source for database migrations, Helm
      templates, Installation schema, bundled Presets, Driver settings, runtime
      dependencies, and required Kubernetes assets.
- [ ] Check candidate access to `presets.files` paths. Restore required files.
      Flag obsolete entries. Image upgrades support only Plugin Driver Installation edits.
- [ ] With [preprovisioning](../../reference/drivers/kubernetes-compute/preprovisioned-namespace.md),
      verify the bound Namespace. Stop here. No initialization Jobs run. Independent
      database migration and Installation bootstrap are prerequisites.
- [ ] For single-cluster discovery only, run with the release kubeconfig and reviewed context
      `kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' get namespaces -l 'openclaw.dev/gateway-namespace,!openclaw.dev/namespace' -L openclaw.dev/gateway-namespace`.
      Require a complete successful list. [Plan adoption](../../reference/drivers/kubernetes-compute/split-layout-installations.md)
      only for absent tenant label, nonempty Gateway label and name `oce-gateways-`
      plus the first 24 hex digits of the Gateway label value's SHA-256.
- [ ] Render with live values (`helm template --is-upgrade`) and
      [correct refused values](production-upgrade-recovery.md#correct-values-the-candidate-refuses)
      before maintenance. Preflight rejects missing Preset files and single-cluster
      [split layouts](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations) before stopping writers.
- [ ] Classify controller, broker and runtime image changes. Controller-only upgrades
      request no deployments. Workers can restart Agent Pods once, interrupting
      repository-bound versions. Runtime upgrades create versions from current Agent
      and Configuration drafts. Trace inputs to the final `runtime` stage through
      `COPY --from=`. Use `grep -nE '^(FROM|COPY)' deploy/runtime/Dockerfile`.
      Rebuild for changed inputs, pinned OpenClaw commit or Codex version. Inputs include
      `apps/controller/src/drivers/repo/github/access/client/` and
      `apps/controller/src/drivers/repo/access/client-contracts.ts`. Controller-rendered Agent Pod specs,
      including `apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts`,
      affect Agents when rerendered.
- [ ] Upgrade the controller first if it supports the deployed runtime.
      Otherwise, follow the release-specific sequence.
- [ ] [Check operator access](#check-operator-access) while the incumbent serves traffic.
- [ ] Freeze concurrent Helm changes, disable OCC autoscalers and restart automation,
      and stop all other database writers through recovery. Freeze Agent deployments
      and settle existing deployment work for every release; also freeze draft edits
      for runtime releases.

### Check operator access

Use the upgrade's OCC CLI, endpoint, CA and protected key file. Verify any
recorded key expiry falls after the recovery window. Check the Installation
ID and fleet access before freezing writers. Set `BASELINE` to the release's
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

If several ingress instances serve the HTTPS host, repeat the Installation
read over fresh connections. Match reads to instances in access logs. Stop
unless every instance returns the expected ID. Keep TLS verification enabled
and credentials out of logs.

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
      require restoring Agent data. For a streamed backup,
      including after an interruption, require the producer to finish successfully
      and compare the archive's byte count and SHA-256 digest at both ends.
      Reject the backup if either differs or the producer failed. Retain
      partial output and diagnostics.
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
- [ ] Inspect sessions and cleanup before broker changes.
      `CLOSED`, missing inventory and `invalidated` do not establish `DISPOSED`.
      Retain unresolved cleanup evidence. Follow [broker recovery](../repository-credentials/installation.md#install-and-verify)
      and [composition guidance](../repository-credentials/installation.md#select-composition-and-network-access).
      Plan interruptions and authorized replacements for running Agents with delivered sessions,
      including controller-only upgrades. Review drafts and deploy grants. Stop if unsafe.

## Assign every surface a disposition

Follow the [operator instructions for each surface](upgrade-dispositions.md).

## Apply the release in dependency order

1. Install cluster prerequisites (on two clusters, upgrade the
   [execution chart](../../testing/kubernetes.md#upgrade-the-execution-chart)
   first) and reconcile protected inputs without replacing retained data.
   Continue to step 2 unless removing obsolete `presets.files` entries.
   Stop for immutable Installation Secrets. Obtain separate review.
   Require `repositoryWorkerRestart` of `not-applicable` or `reverification-supported`
   for every retained running revision in the incumbent's complete deployment inventory.
   Stop otherwise. After baseline capture and broker recovery planning, [remove obsolete entries](production-installation-changes.md)
   and restart API and worker. Preserve saved Presets and grants. Verify against the
   unchanged original baseline. Reconcile protected and live inputs. Capture a separate
   complete baseline and set `BASELINE`.
2. Run the [upgrade preflight](production-upgrade.md#rehearse-before-the-maintenance-window),
   including the candidate's canonical migration check. Stop on unsupported
   history or an unresolved required quiescence step.
3. Upgrade the controller, worker, and Console. The API Pod’s
   [30-second grace period](../../flows/production-startup.md#4-start-private-api-and-worker-deployments)
   can expire mid-request. Keep writers paused through recovery. After forced
   or uncertain shutdown, wait for the database owner to confirm old transactions
   have ended. Pod removal, drained ingress connections, and migration checks
   cannot confirm this. Verify migration, bootstrap, authenticated API recovery,
   and worker readiness.
4. Reconcile resources that startup preserves. Compare complete objects,
   including same-name Presets.
5. For runtime upgrades, the helper deploys recorded running Agents. If interrupted,
   reconcile outcomes, [correct refusals](production-upgrade-recovery.md#correct-a-refused-agent-deployment)
   and [resume](production-upgrade-recovery.md#resume-an-unfinished-prepared-upgrade)
   with original evidence and dispatch journal. Reconcile uncertain sends before retry.
   Never retry unjournaled. Manually [replace recorded failed revisions](production-upgrade-recovery.md#resume-an-unfinished-prepared-upgrade)
   only as authorized. Separate broker recovery. [Channel transitions](one-off-upgrades.md)
   may require redeployment without runtime image changes.
6. Reconcile external integrations and cluster-owned supporting services.
7. Run the acceptance checks below before ending the interruption window.

## Verify the retained installation

- [ ] The [debug](../../reference/console/debug-fields.md) Console **OCE commit**
      matches the candidate's `OCC_BUILD_REVISION`. API and worker run the
      expected controller digest; migration history is canonical.
- [ ] The authenticated Installation and protected startup configuration agree.
      API and worker selected the same Driver identities.
- [ ] Repeat the [operator access checks](#check-operator-access) before
      reopening traffic. Include every restarted or replaced ingress instance.
- [ ] Retain expected `BASELINE` IDs for Namespace, Agent, Configuration, Preset and
      Secret-metadata inventories. Reconcile IAM, Backend, service-account, deployment-work
      and audit-record inventories with `BASELINE`.
      Ordinary controller-only upgrades request no deployments. Verify restarted Pods and
      broker-recovery revisions are ready.
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
read. After partial runtime failure, retain the healthy control plane. Recover only
affected Agents individually under step 5, which grants no independent dispatch
authority. Never delete persistent resources to make the upgrade appear clean.

A write can commit after a timeout or HTTP `503`. Once the database owner
confirms the transaction has ended, check the resource and its
[audit record](../../flows/audit-ledger.md) with authorized reads. Do not
retry a committed write. If the outcome remains unknown, keep writers
paused and do not retry.

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
