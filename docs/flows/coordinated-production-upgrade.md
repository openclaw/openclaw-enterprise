---
created: 2026-09-23
updated: "2026-10-27"
last_updated_session: "authoring-run/f03f716e-ea13-48ab-ad6e-e179b342d585"
---

# Production image upgrade flow

## Overview

`scripts/upgrade-production-images` updates the OpenClaw Control Plane (OCC),
Agent runtimes, or both. The controller-only command ends after the OCC API and
worker recover; it does not request Agent deployments. A runtime release deploys
a new version for every Agent that was running when the command began and ends
after the selected Pods are ready and each replacement gateway passes read-only
Doctor lint. Model and external integration checks remain operator tasks.

## Entry Points

- Trigger: an operator runs `scripts/upgrade-production-images` with one or both
  image options and explicit cluster, release, source, and protected-file inputs.
- Required state: a healthy production Helm release and matching OCC and
  Kubernetes Installation identity. Runtime releases additionally require a
  complete authorized fleet inventory with no deployment in progress.
- Source: `scripts/upgrade-production-images`,
  `packages/occ/src/index.ts:OpenClawController.getInstallationDeploymentInventory`,
  and `packages/occ/src/index.ts:OpenClawController.deployAgent`.

## Flow

```mermaid
graph TD
    A["Validate inputs"] --> Q{"Repository broker enabled?"}
    Q -->|Yes| P["Check image protocol and node architectures"]
    Q -->|No| B["Render and check candidate startup"]
    P --> B
    B --> R{"Preflight only?"}
    R -->|Yes| S["Exit without prepared deployment"]
    R -->|No| T["Save prepared recovery record"]
    T --> C["Read live Secret and Helm state"]
    C --> D{"Candidate Helm release deployed?"}
    D -->|No| E["Stop API and worker Pods"]
    E --> F["Update Secret and run Helm migration"]
    F --> G{"Helm completes?"}
    G -->|No| H["Inspect migration and release before retry"]
    H --> C
    G -->|Yes| I["Verify OCC rollout"]
    D -->|Yes| I
    I --> J{"Runtime release?"}
    J -->|No| K["Hand off application checks"]
    J -->|Yes| L["Deploy recorded Agents"]
    L --> M{"Dispatch response known?"}
    M -->|No| N["Read Agent and stop for reconciliation"]
    N --> L
    M -->|Refused| U["Name refusals and stop for correction"]
    U --> L
    M -->|Yes| O["Check versions, Pods, and Doctor"]
    O --> K
```

## Execution Trace

### 1. Prepare the candidate

`scripts/upgrade-production-images:prepare_upgrade`

The script verifies protected files, cluster, deployed Helm release, and matching
OCC and Secret Installation IDs. It compares all protected and live configuration,
including selected image fields, and captures separate reviewed candidate files. Only
the Slack directory proxy and curated Codex PluginDriver selection may change;
other Helm and Installation settings, including new fields, remain protected.
The broker guard compares references, not ConfigMap or Secret contents. Image
flags select images after comparison. Runtime releases record each running Agent's
baseline version from complete authorized inventory. Nonterminal deployments,
missing selected versions, or unready Namespaces stop preparation. Stopped and
deleting Agents are excluded; pending repository cleanup does not block preparation.

Repository-enabled releases require explicit immutable controller and broker
images. The helper inventories all nodes matching the control plane selector,
including unready and cordoned nodes; they must have one native architecture.
`scripts/upgrade-image-identity.py:read_platform` reads Docker's native OCI export,
resolves the selected manifest's configuration, retains JSON objects within
2 MiB per-blob and 32 MiB total metadata limits, checks their hashes, and verifies
the configuration's platform. Compressed filesystem layers are outside that budget.
`scripts/upgrade-repository-image-probe.mjs` runs both images with synthetic
inputs and a private receipt listener. It checks recovery and refused reservation
through the actual Driver and broker, recording the selected digest, platform
manifest, configuration, requests, and responses. This proves wire compatibility,
not Kubernetes image availability, receipt durability, or disposal. The helper
preserves the live broker hostname; broker restart recovery remains an operator
task in the [broker procedure](../guides/repository-credentials/installation.md#install-and-verify).

After rendering the chart and running a server-side Helm dry run,
[`scripts/upgrade-startup-preflight.mjs`](../../scripts/upgrade-startup-preflight.mjs)
copies rendered API and worker Pod templates (selected controller image, env,
mounts, service account) into one-shot Pods whose Installation volume uses a
temporary candidate Secret. Each runs `loadStartupConfigurationSnapshot` and
`loadInstallationConfiguration`, resolving Drivers and Preset files without the
database. On a typed configuration refusal,
`apps/controller/src/startup-failure.ts:formatStartupConfigurationFailure` prints
up to 32 field diagnostics through the API/worker log filter. The helper saves
the paths and messages in component logs before stopping writers.

With the bundled Kubernetes Compute Driver, each Pod runs
`KubernetesComputeDriver.preflight` with its Kubernetes credentials (its service
account in `inCluster` mode), as API and worker startup do. This refuses, for
example, single-cluster [split-layout Gateway storage](../reference/drivers/kubernetes-compute.md#existing-split-layout-installations).
Each Pod checks the stored Installation name from `occ installation get` with
the image's `isName`, as the controller does after reading the database
(`INSTALLATION_NAME_INVALID`); an image without the rule skips it.

Experimental two-cluster Pods also run
`KubernetesComputeDriver.verifyExecutionTenantGrants` for their component; startup
does not. Where each Pod's identity holds the release-era grant in an execution
tenant Namespace, SelfSubjectAccessReviews ask for newer `openclaw-execution`
rules: API Pod and `pods/proxy` reads, plus `pods/log` and Event reads with runtime
logs; worker Pod `patch` and `batch` Job `get`, `create`,
and `delete`. Worker Job grants are required even with runtime logs disabled.
A missing rule refuses the candidate and points to
[upgrading the execution chart](../testing/kubernetes.md#upgrade-the-execution-chart).

When the chart renders `openclaw-enterprise-dependency-egress`, the helper first
creates a temporary NetworkPolicy with its egress and execution-cluster API
rules. The chart's default-deny NetworkPolicy also selects the Pods. It saves Pod
statuses and logs only after both creates. A startup failure, stuck image pull,
timeout, failed create, or missing usable UID stops preparation before writers
stop and keeps kubectl's error in `preflight-<resource>-create.err`. Best-effort
cleanup deletes the temporary Secret, Pods, and conditional NetworkPolicy only by
the unique ID (UID) returned on create, leaving same-name replacements alone;
`preflight-cleanup.err` records refusals. The operator checks whether an
ambiguous create left an object behind.

With `--preflight-only`, the helper leaves writers running, retains private
evidence, and exits without marking preparation complete. The evidence cannot be
resumed; deployment repeats checks with reviewed inputs in a fresh directory.

For an upgrade, the script saves candidate inputs, inventory, target identity,
and parameter hashes, then marks preparation complete. A per-directory lock
prevents concurrent record use. The operator must freeze other writers,
autoscalers, Helm changes, and runtime draft edits as specified in the
[production guide](../guides/deploy/production-upgrade.md).

### 2. Reconcile a prior attempt

`scripts/upgrade-production-images:506`

On every attempt the script rereads Helm status and values and the Installation
Secret. Only the recorded baseline or candidate values are accepted; the
Secret's UID, Installation annotation, and other data must match the baseline.
Without the prepared record, resume stops: inspect the evidence and any remaining
preflight resources. Resume also binds the original kubeconfig contents,
inputs, OCC URL, scripts, flow, chart, and pair evidence. It requalifies the pair
and rejects a changed eligible-node set. Candidate files must still match the saved reviewed inputs; the
helper applies the saved candidate. Unexpected drift or an in-progress Helm
release stops the command.

If a previously started Helm release is deployed at a newer version with the
candidate values, the script continues without repeating Helm. Otherwise it
requires the operator's migration-history check and refuses a retry while an
initialization Job or Pod remains active. A failed or disconnected migration may have
committed; the check and Job inspection are operator-owned and are not a
rollback. The guide describes the required attestation and recovery.

### 3. Quiesce writers and run the candidate release

`scripts/upgrade-production-images:624`

Before changing the Secret or invoking Helm, the script scales the selected API
and worker Deployments to zero, waits until their Pods disappear, and confirms
both desired replica counts remain zero. Kubernetes requests in this phase share
the configured shutdown deadline. This covers the selected Helm release;
it does not detect independent database writers, autoscalers, or partitioned
nodes. The operator must stop those writers and keep nodes reachable.

The protected files are atomically replaced with the saved candidate. When the
Installation changes, including a controller-only settings release, the script
reads the Secret before updating its Installation key, preserving other data
and metadata with a resource-version precondition.
If the candidate is already present after a lost response, it does not write it
again. The candidate Installation checksum is included in both OCC Pod
templates.

A durable marker precedes `helm upgrade`. The Helm initialization hook checks
the Installation, then runs the candidate migrator and bootstrap, before API and
worker rollout. If Helm
fails, resumption reads its current status and migration state before a retry;
it does not start the old image to undo a committed schema change.

### 4. Verify control-plane recovery

`scripts/upgrade-production-images:694`

The script waits for both OCC Deployments, checks their controller image and
replica count, and checks the Installation checksum when its configuration
changed. It requires exactly one named container for each component. For a
broker-enabled worker it also accepts a restartable init container, provided
no worker exists in the ordinary container list. It rejects a non-restartable
init worker or ambiguous placement. It retries authenticated OCC access and verifies the same Installation ID. A
controller-only release then ends without requesting Agent deployments.
An existing version keeps the Pod specification of the controller that
deployed it only until the worker prepares it again. Agents with repository
credentials get a maintenance pass every 30 seconds (the repository Driver's
`maintenanceIntervalMs`) until their repository session deadline. Other Agents
are prepared again only when their deployment was still finishing as the new
worker took over (the helper checks for unfinished deployments only before a
runtime release).
Kubernetes Compute applies the Gateway and, for dedicated Harnesses, Harness
Deployments as the new controller renders them, with the Installation's current
images, so a changed Pod template (for example new entrypoint arguments or
readiness probes) rolls those Pods once on the unchanged runtime image. Chat is
unavailable until the new Pods are ready, about 17 seconds in one test.
Controller fixes to Gateway and Agent Pods, such as
[diagnostics](agent-deployment-diagnostics.md) mappings, reach an Agent then or
at its next deployment.

For a repository-enabled release, it also verifies the ready API and worker
Pods, their owning ReplicaSets, node architecture, and runtime controller and
broker image IDs against the qualified pair. The deployed Driver checks the real
broker's admission capability without opening a session. Pod identities must
remain stable across that check and before dispatch and completion.

### 5. Deploy and verify the recorded fleet

`scripts/upgrade-production-images:797`

Before sending each ordinary exact-Agent deployment request, the script records
an intent. Successful responses are saved atomically. On resume, existing
responses are reused; an intent without a response triggers an Agent readback
and stops for operator reconciliation. The helper does not infer rejection from
an unchanged selected version or replay an unknown request. An operator can
record a verified accepted response and resume. OCC admits a deployment in one
transaction, so `occ`'s one `Error:` line with a 4xx status and an OCC error
code, other than 408, means no version was saved (`deploy_refusal`). The script
names each refused Agent, or a refused service key, saves the message as
`dispatch/*.rejected`, removes the intent, and stops; `--resume` sends that
request again.

The script polls each returned deployment through its authorized status
operation, confirms the selected version, and waits for all version Pods
to be `Running` and `Ready` on the candidate runtime digest. Before OpenClaw
starts, `GATEWAY_RUNTIME_ENTRYPOINT` runs `openclaw doctor --fix
--non-interactive` once when its shared state or an agent database uses an older
schema, such as a 2026-09-28 release Gateway's; a database still older holds the
Gateway unready with check `state-migration`. A dedicated Harness runs the same
step on its workspace node state before native setup, and a native worker before
it connects (`openClawStateMigrationHelper` in `runtime-startup.ts`). Embedded execution
requires one runtime container; dedicated execution requires both gateway and
Agent containers. Each replacement gateway runs read-only
`openclaw doctor --lint --json --severity-min error` with a heap cap
(`--doctor-heap-mib`, default 384 MiB). Doctor shares the gateway's memory limit;
an OOM kill can stop both. The cgroup v2 check (`gateway_free_memory`) requires
one reading with cap plus 640 MiB free or two consecutive readings with cap plus
256 MiB. This reduces risk without reserving memory or guaranteeing availability.
Transient failures are retried. Initially unavailable data allows warning and run.
After insufficient memory is observed, unavailable reads reset consecutive
evidence; only fresh sufficient readings admit Doctor within the original deadline.
Failure reports separate Doctor's exit status from gateway restarts since Ready.
Missing or incomparable counts or Pod identities report unknown; only a comparable
increase with last termination `OOMKilled` names an OOM kill. A memory timeout
joins started Doctors before releasing the evidence lock.
Failures retain dispatch, status, Pod, and Doctor evidence.

### 6. Hand off application verification

`docs/guides/deploy/production-upgrade.md:Verify the release`

Successful script completion proves the selected Helm rollout and OCC access.
For a runtime release it also proves the recorded deployments and Pods reached
the checked states and Doctor reported no error. The operator next verifies
model responses, providers, channels, credentials, workspace continuity, native
access, and required restore behavior.

### Read-only export after a split-layout refusal

The [split-layout export fallback](../guides/deploy/split-layout-upgrade.md#export-and-re-create)
begins with the read-only `scripts/split-layout-tenants.mjs export --out FILE`.
Its `createOccApi.expect` requires a data envelope for each successful resource
response before `exportTenants` assembles the bundle. Malformed JSON, an empty
body, or a missing data envelope causes export to exit nonzero before `main`
writes the bundle; an actual empty collection remains valid. After restoring
the API response path, the operator retries the read and checks the exported
inventory before proceeding with recovery. Empty
204 deletes and explicitly accepted 404 responses retain their existing meaning.

On re-creation, `importTenants` filters skipped sources and checks that each
selected source Namespace has a distinct target name. Saved destination IDs
remain reserved even when their sources are skipped. It combines those IDs with
selected unsaved sources resolved from live names, and rejects shared destinations
before any mutation or ID-map save. The operator
chooses distinct `--rename` targets, skips a source, or corrects a conflicting
saved map before retrying. A one-to-one mapping can still reuse an empty target
and resume. A skipped source without a saved destination reserves nothing.
The check does not separate resources an older import already merged.

## Debugging and Verification

- For chart or admission failures before mutation, inspect `server-dry-run.txt`;
  for rejected candidates, inspect `preflight-<api|worker>.log` and `-status.json`.
- For native scale, Helm upgrade, or rollout status failures, inspect
  `native-command-failures.tsv`; see [upgrade recovery](../guides/deploy/production-upgrade-recovery.md).
- Before retrying runtime failures, inspect `dispatch/*.error`, `dispatch/*.rejected`,
  version history, and `status/*.json`. Doctor failures: `status/*.doctor.json` and `status/*.doctor.error`.
- Compare `before-workloads.json` and `after-workloads.json` for unexpected
  changes. The controller-only helper requests no Agent deployments; expect one
  same-image Pod template rollout per affected Agent. Separately check
  repository-bound versions affected by broker restart.
  Runtime proof should show intended replacements.
- Use credentialed production Kubernetes integration with distinct baseline
  and candidate images for end-to-end proof. Mocked commands prove only script
  control flow.

## Related docs

- [Production upgrade guide](../guides/deploy/production-upgrade.md)
- [Production installation](../guides/deploy/production-installation.md)
- [Production Agent verification](../guides/deploy/production-agents.md)
- [Agent deployment reference](../reference/agents/deployment.md)
- [Production startup flow](production-startup.md)
- [Controller worker flow](controller-worker.md)
- [Authoritative platform design](../design.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-25 11:53: Record native scale, Helm upgrade, and rollout failures; preserve recovery. (authoring-run/f03f716e-ea13-48ab-ad6e-e179b342d585 - 87784a3230964bd8a7a1763f8350c1fd2b4284e0)
- 2026-10-25 09:19: Keep preflight kubectl errors in private evidence. (authoring-run/6fccb13c-5ec3-44d5-aded-c3c3e9c1da81 - aaabca1fec6b28fbbb674f48f11f015242f86b59)
- 2026-10-25 06:51: Identify temporary preflight resources by UID before cleanup. (authoring-run/d15969fb-1113-416f-9573-e045dd683b66 - dd36945fec0ec3de38cd15b971537eb10a90d0e4)
- 2026-10-23 09:50: Document preflight-only rehearsal and fresh checks at deployment. (authoring-run/3c1a4d88-d619-47e3-9eba-dbaf0988d2e9 - 4e9f5935d5fa4878a719e82db5e504ec6ae55d64)
- 2026-10-20 01:48: Preserve field diagnostics before quiescence. (authoring-run/9d1ff825-b9f4-492a-9420-1e316d820e28 - e7e5f3321cb0a8471d74964eba56ddd069a4e4c5)
- 2026-10-19 22:34: Document that pending repository cleanup does not block upgrade preparation. (authoring-run/d59b973b-1f0b-46bb-b16f-d67bd24ed6d3 - 57acafe81482a890b02ae530793246f2c2e7be79)
- 2026-10-18: The initialization hook checks the Installation before migration.
- 2026-10-12 15:14: Record bootstrap Job grants required by the two-cluster upgrade preflight alongside the fixture correction. (authoring-run/ebb1c629-97b2-4b9a-aa67-a5e750346031 - 9578f6f7aaff9b8545346f43043cbc5b9bcf674e)
- 2026-10-10 03:30: Say that the worker's next preparation of an existing version applies the new controller's Pod templates and rolls changed Pods once. (fix-990-991)
- 2026-10-10 02:10: Require complete successful API responses before publishing the split-layout export bundle. (authoring-run/35b00357-b0c6-459f-aec1-b4fb63620dff - 0886f47d05fdeb2fa4359f4840fb77378d643bac)

[Production image upgrade flow documentation history](coordinated-production-upgrade/history.md) preserves the older dated entries.
