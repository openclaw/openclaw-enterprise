# Upgrade production images

Use `scripts/upgrade-production-images` to release the OpenClaw Control Plane
(OCC), Agent runtimes, or both. Select only the image you intend to change:

- `--controller-image` updates the OCC API and worker. It leaves runtime
  configuration and Agent revisions unchanged.
- `--runtime-image` keeps the current controller image, updates the gateway and
  Agent runtime image, and deploys a new revision for every running Agent.
- Supplying both performs the two changes together.

Runtime upgrades restart the fleet concurrently. Schedule an interruption
window and provide enough capacity for old and replacement revisions to overlap.

The command supports the production Helm and Kubernetes Compute path. It does
not build images, create backups, provision infrastructure, or prove model and
external integration behavior.

## Prepare the release

Prepare:

- each selected image as an immutable `@sha256:` digest with passing checks and
  a reviewed source commit;
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files;
- a PostgreSQL backup before a controller release whose migrations may require
  data restoration; and
- Agent-volume backups before a runtime release whose recovery may require
  restoring runtime data.

The OCC identity needs Installation `read`. A runtime upgrade additionally needs
Installation `administer`, exact `read` access to every Namespace, Agent, and
active Agent revision, plus exact `deploy` access to every running Agent.
Revision read access must also cover the replacement revisions.

Review saved Agent and Configuration drafts before a runtime upgrade. Each
deployment snapshots the current draft, not the previous active revision.

Stop other Helm changes until the command completes. For a runtime upgrade, also
stop Agent deployments and draft edits, and resolve any queued or running Agent
deployment first.

Set the shared inputs:

```bash
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/operator-service-key.json'
export OCC_CA_BUNDLE='/secure/occ/occ-ca.pem'
export RELEASE_SOURCE_SHA='<full-40-character-git-sha>'
export UPGRADE_EVIDENCE="/secure/occ/upgrades/$(date -u +%Y%m%dT%H%M%SZ)"
```

The evidence directory must not exist. The command creates it with mode `0700`.

## Bind the Installation once

Skip this step when the live Installation Secret already has the correct
`openclaw.dev/installation-id` annotation.

After initial production bootstrap, read the Installation ID from the retained
bootstrap key and annotate the Secret:

```bash
export OCC_INSTALLATION_ID="$(jq -er '.meta.installationId' "$OCC_BOOTSTRAP_KEY_FILE")"
export OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName' /secure/occ/values.yaml)"
kubectl --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' --namespace openclaw-system \
  annotate secret "$OCC_INSTALLATION_SECRET" \
  openclaw.dev/installation-id="$OCC_INSTALLATION_ID"
```

Do not replace a different existing ID. Investigate why the cluster and
bootstrap record disagree.

## Upgrade the control plane

Set the controller image and run the command without `--runtime-image`:

```bash
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'

scripts/upgrade-production-images \
  --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' \
  --namespace openclaw-system \
  --release oce \
  --values /secure/occ/values.yaml \
  --installation /secure/occ/installation.yaml \
  --controller-image "$CONTROLLER_IMAGE" \
  --source-revision "$RELEASE_SOURCE_SHA" \
  --evidence-dir "$UPGRADE_EVIDENCE" \
  --occ /secure/occ/bin/occ
```

The command verifies the selected cluster and OCC Installation, checks that the
protected files match live state, renders the chart, and performs a server-side
dry run. It then changes only `images.controller`, runs Helm, waits for the API
and worker, verifies their image, and confirms OCC authentication recovers.

Helm runs the candidate controller's database migration init container with the
migration role, then runs bootstrap. The API and worker do not roll out unless
both hooks succeed. Gateway Pods keep serving their existing revisions and
images; the command does not request fleet inventory or Agent deployment
authority.

For the first release that introduces `occ installation deployment-inventory`,
verify that operation after the controller upgrade before attempting a runtime
upgrade.

Success looks like:

```text
Upgraded controller image; runtime configuration stayed unchanged and no Agent deployments were requested.
```

## Upgrade Agent runtimes

Set the runtime image and run the command without `--controller-image`:

```bash
export RUNTIME_IMAGE='<registry>/runtime@sha256:<64-hex-digest>'

scripts/upgrade-production-images \
  --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' \
  --namespace openclaw-system \
  --release oce \
  --values /secure/occ/values.yaml \
  --installation /secure/occ/installation.yaml \
  --runtime-image "$RUNTIME_IMAGE" \
  --source-revision "$RELEASE_SOURCE_SHA" \
  --evidence-dir "$UPGRADE_EVIDENCE" \
  --occ /secure/occ/bin/occ
```

Before mutation, the command requires a complete authorized inventory with no
deployment in progress. Every running Agent must have a readable active revision
in a ready Namespace.

The command writes the runtime digest to both Kubernetes Compute image fields,
updates the Installation Secret, and runs Helm with the current controller image.
The Installation checksum restarts the API and worker so they load the new
configuration; their software version does not change.

After OCC recovers, the command deploys every recorded running Agent, waits for
durable success, confirms each new active revision, and requires its Pods to be
`Running` and `Ready` on the requested runtime digest. Stopped and deleting
Agents remain untouched. An empty fleet updates the saved runtime selection but
does not prove that the image starts.

OpenClaw runs startup-safe migrations and plugin convergence before each gateway
becomes ready. This workflow replaces immutable images instead of running
`openclaw update`, so the command then runs
`openclaw doctor --lint --json --severity-min error` inside every replacement
gateway. Doctor is read-only here; a reported error fails the upgrade and is
saved under `status/*.doctor.*`. The command never runs `doctor --fix` across
the fleet.

Success looks like:

```text
Upgraded runtime image; controller image remained unchanged and <count> running Agents selected new revisions.
```

To intentionally release both images together, pass both image options. The
command applies the controller and runtime changes in one Helm release before
deploying the recorded fleet.

## Verify the release

Keep the evidence directory private. For every release, inspect the before/live
configuration, rendered chart, server dry run, Helm status, and final API and
worker images.

For a controller-only release, confirm representative existing gateways remain
ready on their original revisions. For a runtime release, inspect
`deployments.jsonl`, `status/*.doctor.json`, and the before/after workload
inventories. Then follow
[Verify production workloads](production-agents.md#verify-production-workloads)
for every execution mode and provider used by the fleet. Require a fresh model
response and check relevant channels, credentials, workspace data, and native UI
access. Doctor lint proves that OpenClaw found no error-level diagnostic; it does
not prove those application paths.

## Recover from a partial failure

For a controller-only failure, inspect the Helm initialization Job and OCC
rollouts. Prefer a reviewed forward fix. Before selecting the previous controller
image, verify that it can read state written by the candidate; Helm rollback does
not reverse database migrations.

A runtime upgrade is not transactional. If OCC succeeds but an Agent deployment
fails, keep the healthy control plane and inspect the exact failed deployment.
Do not retry an unknown response until revision history shows whether OCC
accepted it; a retry can create another revision.

Before rolling back a runtime image, verify that the previous release can read
candidate runtime data. Restore the previous runtime selection, recompute the
Installation checksum, run Helm, and deploy the affected running Agents again.
Never delete Agents, revisions, PVCs, or the bootstrap volume to force recovery.

## Current limits

- No canary, batching, automatic compatibility check, automatic rollback, or
  upgrade lock.
- Runtime upgrades start all recorded Agent deployments concurrently.
- Agent deployments use current drafts rather than recreating active revisions.
- One runtime image is used for both gateway and Agent containers.
- Model, channel, provider, native-access, and restore checks remain manual.

See the [production image upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
