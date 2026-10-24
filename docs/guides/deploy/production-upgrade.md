# Upgrade production images

Use `scripts/upgrade-production-images` for the production Helm and Kubernetes
Compute path. Complete the [upgrade checklist](upgrade-checklist.md) first.

| Selection            | Effect                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--controller-image` | Updates OCC API and worker without requesting Agent deployments. A broker restart can interrupt existing versions. |
| `--runtime-image`    | Updates both gateway and Agent runtime images and deploys a new version for each running Agent.                    |
| Both                 | Applies both image changes in one Helm release, then deploys the recorded fleet.                                   |
| `--broker-image`     | Selects the repository broker when repository credentials are enabled.                                             |

Every release stops the OpenClaw Control Plane (OCC) API and worker for migration
and rollout. Runtime releases also restart the fleet concurrently. Schedule an
interruption and capacity for old and replacement versions to overlap. On the
experimental two-cluster profile, first
[upgrade the execution chart](../../testing/kubernetes.md#upgrade-the-execution-chart).

## Prepare the release

Prepare these inputs and permissions before the maintenance window.

- **Images and source.** Select reviewed images by immutable lowercase
  `@sha256:` digest and a reviewed source commit with passing checks. Use a
  clean checkout at `RELEASE_SOURCE_SHA`. Run the helper from its root, which
  supplies the chart and Collector configuration. Use the OCC CLI from the same
  release, either its [release binary](../cli.md#connect-to-your-installation)
  or `bin/occ` built with `pnpm cli:build`.
- **Protected inputs.** Capture the [pre-upgrade baseline](upgrade-baseline.md).
  Protect the production kubeconfig, Helm values, Installation YAML, OCC service
  key, and optional CA bundle. Baseline files must match live state, including
  image fields. The helper rejects drift.
- **Prerequisites.** Node.js builds preflight Pods. The Kubernetes identity must
  create and delete Pods, Secrets and NetworkPolicies and read Pod logs in the
  release namespace. If the bundled Collector is enabled,
  [refresh its config Secret](../observability.md#refresh-the-collector-configuration-on-upgrade)
  from this checkout and restart it, even for image-only releases. Helm does not
  update the Secret, and differing `collector.yaml` or `kubernetes.yaml` stops
  the helper before mutation.
- **Backups.** Back up PostgreSQL before a controller release whose migration
  might require data restoration. Back up Agent volumes before a runtime release
  whose recovery might require restoring runtime data.
- **OCC permissions.** Every release needs Installation `read`. Runtime releases
  also need Installation `administer`, exact `read` on every Namespace, Agent,
  selected and replacement Agent revision, and exact `deploy` on every running
  Agent. Review Agent and Configuration drafts because deployment snapshots the
  current draft.
- **Repository credentials.** Supply both `--controller-image` and
  `--broker-image`, even when retaining a digest. Stage the trusted images on a
  Linux host running as UID 1000 with Python 3, Node.js, OpenSSL, and Docker
  Engine supporting platform-specific inspection and export. Every node matching
  the control-plane selector must use the host's one native `linux/amd64` or
  `linux/arm64` architecture. Freeze eligible nodes and labels. The Kubernetes
  identity also needs node listing, Deployment, ReplicaSet and Pod reads, and a
  read-only worker-container exec. This preflight checks protocol compatibility.
  Kubernetes availability and admission, image trust, database durability, and
  session disposal require separate verification.

A controller-only release can restart Agent Pods once
([details](breaking-changes-before-2026-10-11.md#2026-10-10-controller-only-releases-can-restart-agent-pods-once)).
A broker restart loses delivered sessions. Plan interruption and authorized
replacement versions, review their drafts and deploy grants, and stop if recovery
cannot be performed safely. Lost sessions fail their versions and queue retirement.
Inspect retained cleanup and follow
[broker recovery](../repository-credentials/installation.md#install-and-verify).

During the maintenance window and recovery, stop other Helm changes, autoscalers,
automation that can restart or scale OCC, and all other OCC database writers,
including independent API, worker, and maintenance processes. Confirm nodes are
reachable. Do not force-delete OCC Pods, since a missing Pod cannot prove a
partitioned writer stopped. The helper stops and waits for the selected release's
API and worker; it cannot detect independent writers. For runtime upgrades also
freeze Agent deployments and draft edits and resolve queued or running deployments.

Set the shared inputs and arguments. The evidence directory must not exist; the
helper creates it with mode `0700`. Confirm `git status --porcelain` is empty
before continuing.

```bash
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/operator-service-key.json'
export OCC_CA_BUNDLE='/secure/occ/occ-ca.pem'
export RELEASE_SOURCE_SHA='<full-40-character-git-sha>'
export UPGRADE_EVIDENCE="/secure/occ/upgrades/$(date -u +%Y%m%dT%H%M%SZ)"
cd /secure/src/openclaw-enterprise # the release checkout
git fetch origin
git checkout --detach "$RELEASE_SOURCE_SHA"
git status --porcelain
UPGRADE_ARGS=(
  --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>'
  --namespace openclaw-system --release oce
  --values /secure/occ/values.yaml --installation /secure/occ/installation.yaml
  --source-revision "$RELEASE_SOURCE_SHA" --occ /secure/occ/bin/occ
)
```

### Include reviewed settings

Keep `--values` and `--installation` as the live baseline. Make owner-only
candidate copies and review the complete diff:

```bash
cp /secure/occ/values.yaml /secure/occ/candidate-values.yaml
cp /secure/occ/installation.yaml /secure/occ/candidate-installation.yaml
chmod 600 /secure/occ/candidate-values.yaml /secure/occ/candidate-installation.yaml
UPGRADE_ARGS+=(
  --candidate-values /secure/occ/candidate-values.yaml
  --candidate-installation /secure/occ/candidate-installation.yaml
)
```

Candidates may change the
[Slack directory proxy](../integrations/slack.md#configure-both-slack-proxies)
and select the [curated Codex PluginDriver](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
Review their compatibility with selected images, Agent drafts, and credentials.
Startup preflight does not prove external access. Other settings, including IAM,
authentication, Installation identity, database, bootstrap, native administration,
Compute identity, cluster trust, and repository settings, remain protected.
Repository settings include the GitHub Backend and registry path, Repo Driver, and
Compute credential-service peer. Select images using their flags; do not edit image
fields or the managed Installation checksum in the copies.

Keep the referenced registry ConfigMap, broker trust Secrets, and other external
credential-service configuration unchanged through release and recovery. The
helper compares references, not their contents. Review them against the
[repository installation guide](../repository-credentials/installation.md).
The helper saves candidates in private evidence and writes the final candidate to
the baseline paths. Installation changes also update its Secret and restart OCC.
Keep the candidate files unchanged at the same paths for recovery.

### Apply other Installation changes

Apply other settings, such as recommended resource values, separately using
[Installation changes](production-installation-changes.md). The helper refuses
a candidate Installation that changes anything beyond Plugin Driver selection.

## Bind the Installation once

Skip this step when the live Installation Secret has the correct
`openclaw.dev/installation-id` annotation. After initial bootstrap, use the
retained bootstrap key:

```bash
export OCC_INSTALLATION_ID="$(jq -er '.meta.installationId' "$OCC_BOOTSTRAP_KEY_FILE")"
export OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)"
kubectl --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' --namespace openclaw-system \
  annotate secret "$OCC_INSTALLATION_SECRET" \
  openclaw.dev/installation-id="$OCC_INSTALLATION_ID"
```

Do not replace a different existing ID. Investigate the disagreement first.

## Rehearse before the maintenance window

Run the intended command below with `--preflight-only`, the reviewed inputs, and a
new private evidence directory. It checks the baseline, chart, server dry run,
startup Pods, and repository image pair when enabled. OCC writers keep running.
The helper attempts to delete its temporary Pods, Secret, and NetworkPolicy;
inspect the private evidence and clean up leftovers with the command below.

A preflight does not create a prepared deployment or grant approval. Its evidence
cannot be resumed, and `--preflight-only` cannot be combined with `--resume`. For
the release, choose a new `UPGRADE_EVIDENCE` path and omit `--preflight-only`.
The helper repeats checks against live state. Allow time for the upgrade and
recovery and keep the maintenance restrictions above.

## Upgrade the control plane

Check for [split-layout tenants](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations)
before the window. Releases with the shared tenant namespace reject them on a
single-cluster Installation.

```bash
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'
scripts/upgrade-production-images "${UPGRADE_ARGS[@]}" \
  --controller-image "$CONTROLLER_IMAGE" --evidence-dir "$UPGRADE_EVIDENCE"
```

For repository credentials, set `BROKER_IMAGE` to the selected immutable digest
and add `--broker-image "$BROKER_IMAGE"` to the command. The helper preserves
the broker hostname, qualifies the image pair before cluster mutation, and
verifies the deployed pair and capability. The
[startup preflight flow](../../flows/coordinated-production-upgrade.md#1-prepare-the-candidate)
explains its checks. If one fails, inspect `preflight-<api|worker>.log` and
`preflight-<api|worker>-status.json`. The helper reports each failure, attempts
cleanup, and leaves the old release serving. Status and log collection can take
about 90 seconds past `--timeout-seconds`. Follow
[name recovery](production-upgrade-recovery.md#correct-an-invalid-installation-name)
for an invalid Installation name. If the helper is killed, remove its leftovers:

```bash
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system delete pod,secret,networkpolicy.networking.k8s.io \
  -l 'app.kubernetes.io/instance=oce,app.kubernetes.io/component=upgrade-preflight'
```

After preflight, the helper quiesces OCC. Helm runs the candidate migration with
the migration role, then bootstrap, before restoring API and worker. The helper
checks rollout and OCC access. It does not request Agent deployments. A later
replacement version does not settle old cleanup or replay repository operations.
For the first release introducing `occ installation deployment-inventory`, verify
that operation after this upgrade before attempting a runtime release.

```text
Upgraded controller image; no Agent deployments were requested.
```

## Upgrade Agent runtimes

```bash
export RUNTIME_IMAGE='<registry>/runtime@sha256:<64-hex-digest>'
scripts/upgrade-production-images "${UPGRADE_ARGS[@]}" \
  --runtime-image "$RUNTIME_IMAGE" --evidence-dir "$UPGRADE_EVIDENCE"
```

For repository credentials, also pass `--controller-image` with the current
controller digest and `--broker-image` with the selected digest. The worker and
broker restart. The helper requires complete authorized inventory and no active
deployment. Every running Agent needs a readable selected version in a ready
Namespace. A refusal lists up to ten Agents without one. Stop or delete each, or
deploy it until it succeeds, then start with a new evidence directory.

The helper updates both Kubernetes Compute image fields and the Installation
Secret after quiescence. Helm uses the current controller image and restarts OCC
with the new checksum. After OCC recovers, the helper deploys each recorded
running Agent, waits for durable success, verifies its selected version and
`Running` and `Ready` Pods on the requested digest, and runs read-only
`openclaw doctor --lint --json --severity-min error` in each replacement gateway.
Errors fail the upgrade and appear under `status/*.doctor.*`. Stopped and deleting
Agents are excluded. An empty fleet updates the selection without proving image
startup. Gateway startup handles older state as described in
[gateway storage](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).

For a combined release, add `--controller-image "$CONTROLLER_IMAGE"` to the
runtime command with the new controller digest.

```text
Upgraded runtime image; controller image remained unchanged and <count> running Agents selected new revisions.
```

## Verify the release

Keep evidence private. Inspect before/live configuration, the rendered chart,
server dry run, Helm status, and final API and worker images. For controller-only
releases, confirm gateway readiness and replacement versions needed after a broker
restart. For runtime releases, inspect `deployments.jsonl`, `status/*.doctor.json`,
and before/after workload inventories.

Follow [Verify production workloads](production-agents.md#verify-production-workloads)
for every execution mode and provider. Require a fresh model response and check
channels, credentials, workspace data, and native UI access. Doctor lint reports
OpenClaw diagnostics and does not establish those application paths.

### Verify the user-facing Console after promotion

For the controller routed to users, [verify the served Console](../../release/container-promotion.md#verify-the-served-console)
and retain the result with the private upgrade evidence.

## Recover from a partial failure

Keep the evidence directory and maintenance restrictions. Do not start another
upgrade. [Recover a partial production upgrade](production-upgrade-recovery.md)
covers resumption, uncertain migrations, unknown Agent dispatches, and older images.

### Roll back across human sign-in

Migration `0037` adds human sign-in state, which `helm rollback` does not reverse.
Follow [rollback across human sign-in](production-upgrade-recovery.md#roll-back-across-human-sign-in).

## Current limits

- No canary, batching, general runtime compatibility check, automatic rollback,
  or cluster-wide upgrade lock. Runtime deployments start concurrently.
- Agent deployments use current drafts. One runtime image serves gateway and
  Agent containers.
- Model, channel, provider, native-access, and restore checks remain manual.

See the [production image upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
