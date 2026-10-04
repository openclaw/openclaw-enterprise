# Plan an OpenClaw Enterprise upgrade

Use this checklist before changing an OpenClaw Enterprise (OCE) controller,
runtime, Helm chart, or Installation configuration in an environment that must
retain data. It inventories the state boundaries an operator must classify so
an image update does not silently leave old configuration or Namespace-owned
copies behind.

The checklist complements the
[production image upgrade procedure](production-upgrade.md) and the
[persistent local k3d procedure](local-k3d-image-upgrade.md). A custom retained
Compose or Compose-and-k3d environment has no supported in-place upgrade
command. Use this page as its migration inventory, retain its named volumes,
cluster, and private state directory, and maintain a reviewed procedure for its
own topology.

## Classify the release

- [ ] Record the candidate OCE source commit, upstream OpenClaw commit, Codex
      version, configured image references, and immutable controller and runtime
      image digests. Confirm the build source was clean and recorded. Do not use
      a moving tag or a configured reference alone as upgrade evidence.
- [ ] Diff the deployed and candidate source for database migrations, Helm
      templates, Installation schema, bundled Presets, Driver settings, runtime
      dependencies, and required Kubernetes assets.
- [ ] Confirm the recorded image source includes the changes required for this
      release; a published tag alone does not establish their inclusion.
- [ ] Decide whether this is a controller-only, runtime-only, or coordinated
      release. A controller-only release does not request Agent deployments; a
      worker restart can still interrupt repository-bound revisions. A runtime
      release creates new revisions from current Agent and Configuration drafts.
- [ ] Check controller/runtime compatibility. Upgrade the controller first when
      it supports the deployed runtime. Use a release-specific sequence when the
      versions cannot run together.
- [ ] Freeze concurrent Helm changes, disable OCC autoscalers and restart automation,
      and stop all other database writers through recovery. For runtime releases,
      also stop Agent deployments and draft edits and resolve existing deployment work.

## Record the starting state

Create a private evidence directory and record these values before mutation.
[Record the pre-upgrade baseline](upgrade-baseline.md) gives commands for many of them:

- [ ] OCC Installation ID, cluster/context, Helm release or Compose project,
      source revision, chart revision, and all running image digests.
- [ ] Protected Helm values and Installation YAML, plus the live rendered values
      and mounted Installation Secret or file. Resolve unexplained drift first.
- [ ] Database migration catalog and receipts. Take a PostgreSQL backup when
      recovery could require restoring control-plane data.
- [ ] Namespace, Agent, Configuration, Preset, Secret metadata, IAM Role,
      AccessBinding, Backend, service account, active revision, desired state,
      deployment work, and audit-record inventories. Do not record Secret values
      in upgrade evidence.
- [ ] Kubernetes Namespace labels, RoleBindings, Services, NetworkPolicies,
      Gateway resources, storage classes, seccomp profiles, and supporting
      controller or sidecar versions.
- [ ] PVC names and UIDs, PV names, representative workspace file hashes,
      session counts, and gateway state. Arrange separate volume backups when
      recovery could require restoring Agent data.
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

Do not treat “the image was replaced” as evidence that these other surfaces
changed.

| Surface                                                           | Disposition                                  | Upgrade behavior                                                                                                                                                                                                                                                                    | Required operator action                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller, worker, and Console assets                            | Replace                                      | The controller image owns all three.                                                                                                                                                                                                                                                | Roll out API and worker together. Verify the embedded source revision and both observed image digests or IDs.                                                                                                                                                                                                |
| PostgreSQL schema and migration-owned data                        | Auto-migrate and preserve                    | The canonical migrator applies supported pending migrations before API and worker startup. An image rollback does not reverse them.                                                                                                                                                 | Run migration preflight, inspect pending migrations, retain the receipt, and stop all old writers. The production image helper quiesces the API and worker; the operator must stop other writers. Prefer a reviewed forward fix after commit.                                                                |
| Installation YAML                                                 | Reconcile manually                           | API and worker read it independently at startup. Updating a protected file alone does not reload either process.                                                                                                                                                                    | Reconcile every Driver, Backend, image, network, storage, logging, and Preset-file setting. Update the mounted Secret or file and restart API and worker.                                                                                                                                                    |
| IAM, Backends, and control-plane records                          | Preserve and reconcile                       | Namespaces, Roles, AccessBindings, service accounts, Backends, deployment work, and audit records persist in PostgreSQL; external identity providers and sinks do not.                                                                                                              | Compare counts and stable IDs, retain service-principal ownership, finish or resolve active work, and verify audit and observability delivery.                                                                                                                                                               |
| Helm chart and cluster prerequisites                              | Reconcile manually                           | Helm reconciles chart-owned resources. CRDs, node assets, storage classes, cluster overlays, and external controllers may have separate owners.                                                                                                                                     | Diff the rendered candidate against live resources. Preserve reviewed RBAC, selectors, NetworkPolicies, sidecars, probes, Gateway and HTTP routes, certificates, DNS rewrites, CSI and local-path settings, proxy rules, and seccomp profiles. Apply prerequisites before workloads need them.               |
| Bundled Collector configuration                                   | Reconcile manually                           | The Collector reads the operator-created Secret named by `logging.collector.configSecretName`. Helm never updates it, so the previous release's log filtering remains.                                                                                                              | [Refresh](../observability.md#refresh-the-collector-configuration-on-upgrade) `collector.yaml` and `kubernetes.yaml` from the release source, merge reviewed local changes, and restart the Collector.                                                                                                       |
| Default and file-backed Presets                                   | Create missing; reconcile existing           | Startup creates missing names in each eligible Namespace. It deliberately preserves an existing same-name Namespace Preset without comparing templates.                                                                                                                             | Compare complete persisted templates with candidate files. `PATCH` intended same-name Presets in place so IDs, IAM grants, and bookmarks remain stable. Remove obsolete copies only after checking exact-resource references.                                                                                |
| Agent draft and Configuration metadata                            | Preserve                                     | PostgreSQL stores Agent drafts, Configuration metadata, references, and revision relationships. A deployment snapshots the current draft rather than replaying the active revision.                                                                                                 | Review drafts before a runtime release. Preserve IDs and do not assume a bundled default rewrites saved Configuration JSON.                                                                                                                                                                                  |
| Configuration values                                              | Preserve in the selected ConfigurationDriver | The current Kubernetes Driver stores values in ConfigMaps; the filesystem development Driver uses `occ_configuration_data`. Switching Drivers does not migrate values.                                                                                                              | Inventory and back up the active Driver's storage. Keep the Driver identity stable, or run a separately reviewed data migration before changing it.                                                                                                                                                          |
| Runtime image selection                                           | Reconcile manually                           | Installation configuration selects images for future deployments. Reloading the controller does not replace active Agent workloads.                                                                                                                                                 | Set immutable gateway and Agent runtime digests and restart API and worker. The production helper deploys every recorded running Agent; it has no selected-Agent or canary mode. Leave stopped and deleting Agents untouched.                                                                                |
| Agent revisions and Kubernetes workloads                          | Preserve or redeploy deliberately            | Controller-only releases do not request deployments, but a broker restart can fail repository-bound revisions and queue retirement. Runtime releases create immutable replacement revisions through the ordinary deployment path. Projected runtime Secrets and Pods are recreated. | Record the fleet first, allow replacement capacity and downtime, wait for durable deployment success, and verify the selected revision and Pod digest. Never replay an unknown deployment response until revision history shows whether OCC accepted it.                                                     |
| Secret metadata, values, and generated credentials                | Preserve across both stores                  | PostgreSQL stores Secret metadata and references; the selected SecretDriver owns values. External tokens, Slack apps, and provider accounts can change outside OCE.                                                                                                                 | Back up the owning Secret store, preserve canonical Kubernetes Secrets, verify references and access metadata, and prove delivery with a real operation. Never copy credential bytes into Compose, YAML, logs, or upgrade evidence.                                                                          |
| Repository access and broker state                                | Reconcile durable inputs; recreate sessions  | Repository metadata, broker image, service name, CA, runtime policy, volumes, and external GitHub App grants must remain compatible. Broker sessions are ephemeral and image rollout does not expand external installations.                                                        | Preserve the exact Service name, hostname, certificate, and CA until old sessions drain, along with repository volumes and grants. A lost session can fail its revision; inspect cleanup and explicitly deploy a new authorized revision when needed. Verify clone and the required read or write operation. |
| Plugin integrations                                               | Reconcile manually                           | Catalogs, policy, credentials, and external authorization are independent of an image replacement.                                                                                                                                                                                  | Reconcile catalog availability, reviewer policy, NetworkPolicies, Secret bindings, and external grants. Verify a representative tool call.                                                                                                                                                                   |
| Authentication, TLS, and routing                                  | Preserve and reconcile                       | Auth secrets, hostnames, cookie scope, certificates, Gateway routes, and trusted-proxy CIDRs are operator-owned. Auth sessions may be invalidated when these change.                                                                                                                | Preserve stable secrets when sessions should survive. Reconcile origins and routes with the live hostname, and verify human login, service-key access, workspace routing, and native admin access.                                                                                                           |
| PostgreSQL, bootstrap, workspace, gateway, and repository volumes | Preserve                                     | These survive only while their external database, PVCs, k3d volumes, or Compose volumes remain. Images do not recreate them.                                                                                                                                                        | Keep the existing resources and reclaim policies. Do not delete these to force an upgrade through, except the explicitly discarded legacy RWX Agents below.                                                                                                                                                  |
| Native-admin pod-local edits and broker sessions                  | Recreate or discard                          | Pod-local changes and in-memory sessions disappear when the owning Pod restarts. Managed Configurations and PVC data persist.                                                                                                                                                       | Move intended configuration into a managed resource before rollout. Inspect lost sessions and retained cleanup obligations; worker maintenance does not recreate lost sessions.                                                                                                                              |
| Long-lived local profile state                                    | Preserve and reconcile manually              | Compose files, bind mounts, kubeconfig, cluster name, image tags, private state files, and named volumes sit outside the release image.                                                                                                                                             | Update every image consumer, retain PostgreSQL and k3d volumes, add new mounted files explicitly, and verify rendered Compose and Helm configuration before recreating only affected services. A custom retained topology needs its own procedure.                                                           |

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

1. Install cluster prerequisites and reconcile protected inputs without replacing
   retained data.
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

- [ ] The Console reports the candidate source revision. API and worker run the
      expected controller digest, and migration history is canonical.
- [ ] The authenticated Installation and protected startup configuration agree.
      API and worker selected the same Driver identities.
- [ ] Namespace, Agent, Configuration, Preset, and Secret-metadata inventories
      contain the expected IDs, accounting for recorded legacy RWX deletions and
      newly created replacement Agents. IAM, Backend, service-account, deployment-work,
      and audit-record inventories also reconcile. The controller-only helper
      requests no deployments; check for revisions affected by broker restart.
- [ ] Persisted Preset templates match the intended source definitions. Missing
      defaults were created, intended same-name copies were updated in place,
      and obsolete copies were handled deliberately.
- [ ] Runtime releases selected new successful revisions. Gateway and Agent Pods
      are ready on the requested digest; stopped Agents were not started.
- [ ] PVC and PV identities, workspace hashes, gateway state, and representative
      sessions match the baseline for retained Agents. Recreated legacy RWX Agents
      have new identities and fresh storage; verify their new RWO claims instead.
- [ ] Authentication, audit, metrics, traces, and alert delivery still reach
      their configured sinks.
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
      exceptions. It contains no credential values.

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
