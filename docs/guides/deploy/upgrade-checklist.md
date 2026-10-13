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
- [ ] Confirm the candidate image still ships every `/app/deploy/presets/` file
      that `presets.files` names; the image helper's startup preflight stops
      before quiescence on a missing one. Images built after #779 (2026-09-30)
      drop the four `devday*.json` files. The helper refuses Installation
      changes other than the Plugin Driver, so remove those entries and restart
      first; saved Presets stay.
      You can add `/app/deploy/presets/swe-preset.json` (formerly
      `devday.json`) afterward.
- [ ] On a single-cluster install, run
      `kubectl get namespaces -l openclaw.dev/gateway-namespace -L openclaw.dev/namespace`.
      Releases with the shared tenant namespace refuse to start while a row has
      an empty `NAMESPACE` column (a
      [split-layout tenant](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations));
      the image helper's preflight stops before quiescence.
- [ ] Before the window, render the candidate chart with your live values
      (`helm template`): releases after 2026-10-05
      [refuse some values](production-upgrade-recovery.md#correct-values-newer-releases-refuse)
      older ones accepted. The image helper renders again and runs its startup
      preflight before stopping anything.
- [ ] Decide whether this is a controller-only, runtime-only, or coordinated
      release. A controller-only release does not request Agent deployments,
      but the new worker can restart existing Agent Pods once and interrupt
      repository-bound revisions. A runtime
      release creates new revisions from current Agent and Configuration drafts.
- [ ] Check controller/runtime compatibility. Upgrade the controller first when
      it supports the deployed runtime. Use a release-specific sequence when the
      versions cannot run together.
- [ ] Freeze concurrent Helm changes, disable OCC autoscalers and restart automation,
      and stop all other database writers through recovery. For runtime releases,
      also stop Agent deployments and draft edits and resolve existing deployment work.

## Record the starting state

Create a private evidence directory and record these values before mutation.
[The pre-upgrade baseline](upgrade-baseline.md) gives commands for many:

- [ ] OCC Installation ID, cluster/context, Helm release or Compose project,
      source revision, chart revision, and all running image digests.
- [ ] Protected Helm values and Installation YAML, plus the live rendered values
      and mounted Installation Secret or file. Resolve unexplained drift first.
- [ ] Database migration catalog and receipts. Back up PostgreSQL when
      recovery could require restoring control-plane data.
- [ ] Namespace, Agent, Configuration, Preset, Secret metadata, IAM Role,
      AccessBinding, Backend, service account, active revision, desired state,
      deployment work, and audit-record inventories. Never record Secret values.
- [ ] Kubernetes Namespace labels, RoleBindings, Services, NetworkPolicies,
      Gateway resources, storage classes, seccomp profiles, and supporting
      controller or sidecar versions.
- [ ] PVC names and UIDs, PV names, representative workspace file hashes,
      session counts, and gateway state. Back up volumes when recovery could
      require restoring Agent data.
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
      Resolve unsupported approval fields or values deliberately, including the
      former `native`, `prompt`, and `approve` values when upgrading to a
      candidate that rejects them. Verify intended reviewer and approval behavior
      before deploying those drafts.
- [ ] If the dedicated Codex Localhost seccomp profile is used, verify its
      artifact and sandbox probe on every eligible node, including replacement
      nodes. Reassess it when the node or runtime inputs change; follow the
      [Codex sandbox procedure](codex-sandbox.md).
- [ ] Inspect repository session and cleanup obligations before restarting the
      broker. `CLOSED`, missing inventory, and `invalidated` attempts do not
      establish `DISPOSED`; retain unresolved cleanup evidence and follow the
      [broker upgrade and recovery procedure](../repository-credentials/installation.md#select-composition-and-network-access).
- [ ] If a rollout replaces the worker's enabled repository broker, identify
      running Agents with delivered repository sessions. Plan an interruption
      and authorized replacement revisions for affected Agents, including for a
      controller-only release. Review their current drafts and required deploy
      grants. Stop if that recovery cannot be performed safely.

## Assign every surface a disposition

Give every surface the disposition and operator action listed in
[upgrade surface dispositions](upgrade-dispositions.md), from controller images
and database migrations to retained volumes and local profile state.

## Remove legacy RWX workspaces

After recording the baseline and completing any required backups above, remove
legacy RWX development Agents before deploying the RWO-only controller:

1. Inventory Harness workspace PVC access modes and confirm with their Agent
   owners which legacy RWX-backed Agents can be discarded. Record these as
   intentional deletions in the inventory.
2. Using the current compatible OCE version, delete those Agents through OCE and
   confirm their workspace PVCs are gone. Deleting an Agent also deletes its
   Gateway state; this transition does not preserve or migrate its data. Keep the
   old API and worker running for this cleanup, then quiesce them for the upgrade.
3. Upgrade only after no legacy RWX Harness claims remain. Recreate any needed
   Agents with new RWO storage.

Do not change PVC access modes in place. The RWO-only version rejects legacy
RWX claims during reconciliation and final Agent deletion; upgrading first can
block both redeployment and cleanup. A failed deletion can already have removed
Gateway state before rejecting the Harness claim; it does not preserve the whole
Agent. Existing RWO-backed Agents need no recreation.

## Apply the release in dependency order

1. Install cluster prerequisites (on two clusters, upgrade the
   [execution chart](../../testing/two-cluster-local.md#upgrade-the-execution-chart)
   first) and reconcile protected inputs without replacing retained data.
2. Run the canonical migration preflight. Stop if the history is unsupported or
   a required quiescence step is unresolved.
3. Upgrade the controller, worker, and Console. Wait for database migration,
   bootstrap, authenticated API recovery, and worker readiness. The old API Pod
   stops first and finishes admitted requests within its 30-second grace
   ([shutdown timing](../../flows/production-startup.md#4-start-private-api-and-worker-deployments)).
4. Reconcile persisted resources that startup intentionally preserves, including
   same-name Presets. Compare complete objects, not only counts or names.
5. Update runtime image selection only when required. Reload API and worker, then
   deploy the recorded running fleet through OCC.
6. Reconcile external integrations and cluster-owned supporting services.
7. Run the acceptance checks below before ending the interruption window.

## Verify the retained installation

- [ ] The [debug](../../reference/console/debug-fields.md) Console **OCE commit**
      matches the candidate's `OCC_BUILD_REVISION`. API and worker run the
      expected controller digest; migration history is canonical.
- [ ] The authenticated Installation and protected startup configuration agree.
      API and worker selected the same Driver identities.
- [ ] Namespace, Agent, Configuration, Preset, and Secret-metadata inventories
      contain the expected IDs, accounting for recorded legacy RWX deletions and
      newly created replacement Agents. IAM, Backend, service-account, deployment-work,
      and audit-record inventories also reconcile. The controller-only helper
      requests no deployments, but affected Agents' Pods can restart once on the
      same image; check for revisions affected by broker restart.
- [ ] Persisted Preset templates match the intended source definitions. Missing
      defaults were created, intended same-name copies were updated in place,
      and obsolete copies were handled deliberately.
- [ ] Runtime releases selected new successful revisions. Gateway and Agent Pods
      are ready on the requested digest; stopped Agents were not started.
- [ ] PVC and PV identities, workspace hashes, gateway state, and representative
      sessions match the baseline for retained Agents. Recreated legacy RWX Agents
      have new identities and fresh storage; verify their new RWO claims instead.
- [ ] Authentication, audit, metrics, traces, and alert delivery still reach
      their sinks.
- [ ] A real model response succeeds for each execution mode and provider in
      scope. Startup and Pod readiness alone do not prove model access.
- [ ] Required Slack or other channel delivery, repository clone or write,
      plugin tool policy, workspace access, and native admin UI each pass a
      representative live check. Where plugin approval is required, verify an
      approval and a denial through the intended reviewer.
- [ ] Where CredentialSources are enabled, confirm source status and Agent
      bindings, then verify a real model response through the selected Gateway.
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

## Related guides

- [Upgrade production images](production-upgrade.md)
- [Upgrade images on a persistent local k3d installation](local-k3d-image-upgrade.md)
- [Local Kubernetes development](local-kubernetes-development.md)
- [Install the production control plane](production-installation.md)
- [Deploy and verify production Agents](production-agents.md)
- [Preset behavior](../../reference/presets.md)
- [Production upgrade flow](../../flows/coordinated-production-upgrade.md)
