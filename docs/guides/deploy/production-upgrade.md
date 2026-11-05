# Upgrade production images

Run `scripts/upgrade-production-images` from the release checkout to change
images in an existing Helm installation with Kubernetes Compute. Use the
matching [OCC CLI](../cli.md#connect-to-your-installation). For a new
installation, follow [install the production control plane](production-installation.md).
For one Agent, follow [deploy and verify production Agents](production-agents.md).
Plan any traffic handoff separately from this in-place upgrade.

1. [Select and prepare the release](#prepare-the-release). Record the live
   baseline and take the backups required by the [upgrade checklist](upgrade-checklist.md).
2. [Preflight the target](#rehearse-before-the-maintenance-window).
   [Compare manifests](upgrade-baseline.md#compare-the-candidate-with-the-installed-manifest).
3. Freeze writers. Apply the [control plane](#upgrade-the-control-plane) or
   [runtime](#upgrade-agent-runtimes) upgrade once with fresh evidence.
4. [Verify the release](#verify-the-release) with a real workload.
5. [Recover from a partial failure](#recover-from-a-partial-failure) before retrying.

Select `--controller-image` for the OCC API and worker, and `--broker-image`
for the repository broker when credentials are enabled. A broker restart can
interrupt existing Agent versions. `--runtime-image` updates the gateway and
runtime image and redeploys every running Agent concurrently. Each upgrade
stops the API and worker during migration and rollout. Allow capacity for old
and replacement versions to overlap.

The helper checks chart paths and bytes against the selected commit before
contacting the cluster. Keep evidence and baselines outside the chart. Keep the
checkout unchanged and under your exclusive control.

For settings changes, [prepare reviewed candidate files](#include-reviewed-settings).
For the experimental two-cluster profile, first
[upgrade the execution chart](../../testing/kubernetes.md#upgrade-the-execution-chart).

## Prepare the release

If you retain conversations, send a unique nonsecret marker in a test
conversation through the approved interface. Privately record its Agent and
location.

Prepare:

- images pinned by lowercase `@sha256:` digest, with passing checks and a full
  reviewed commit. Use [published digests](../../release/containers.md#prepare-and-publish)
  or build your own;
- a clean release checkout at `RELEASE_SOURCE_SHA`. Run the helper from its
  root to check the chart and live Collector configuration;
- the matching OCC CLI at `--occ` (`/secure/occ/bin/occ` below). Use the
  [release binary](../cli.md#connect-to-your-installation) or build it with
  `go build -trimpath -o bin/occ ./cmd/occ` in the release checkout. The helper
  uses the CLI to read deployment inventory and deploy Agents;
- a [pre-upgrade baseline](upgrade-baseline.md) of Helm, Kubernetes, OCC and
  database state;
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files;
- Bash, Python 3, Node.js, Helm, kubectl, jq, yq, cmp and mktemp on the operator host. The Kubernetes identity must create and
  delete Pods, Secrets and NetworkPolicies and read Pod logs in the release
  namespace;
- for the bundled Collector, [refresh its config Secret](../observability.md#refresh-the-collector-configuration-on-upgrade)
  from the release checkout and restart the Collector, even for image-only
  releases. Helm leaves the Secret as is. The helper stops before mutation if
  its `collector.yaml` or `kubernetes.yaml` differs;
- PostgreSQL backups for controller migrations that can require data
  restoration, and Agent-volume backups for runtime releases that can require
  runtime data restoration.

For repository-enabled releases, pass both `--controller-image` and
`--broker-image`, even when you retain the current digest. Stage the exact operator-trusted
images on a Linux host running as UID 1000. Docker Engine must support
platform-specific image inspection and export. Install Python 3, Node.js and
OpenSSL. Every node matching the control-plane selector must match the host's native
`linux/amd64` or `linux/arm64` architecture. Freeze eligible nodes and their labels
during maintenance. The Kubernetes identity must list nodes, read Deployments,
ReplicaSets and Pods, and run a read-only check in the worker container. Local
preflight checks protocol compatibility. Check Kubernetes image availability
and admission, image trust, database durability and session disposal separately.

The OCC identity needs Installation `read`. Runtime upgrades also require
Installation `administer`, exact `read` on every Namespace, Agent, Agent
Configuration, and selected and replacement Agent revision, and exact `deploy`
on each running Agent.

Review saved Agent and Configuration drafts before a runtime upgrade. Each
deployment takes a new snapshot of the current draft.

If a controller-only release changes the rendered Pod specs, the new worker
restarts affected Agent Pods once on the same image. A broker restart recreates
dedicated Codex Pods and can leave sessions the worker cannot replace. Plan the
interruption and authorized replacement versions. Review affected Agents'
drafts and deploy grants. Stop if recovery is unsafe. Follow the
[broker recovery procedure](../repository-credentials/installation.md#install-and-verify).

During maintenance, freeze other Helm changes and disable automation, including
autoscalers, that restarts or scales OCC Deployments. Stop other OCC database writers, including
independent API, worker or maintenance processes. Confirm nodes are reachable.
Do not force-delete OCC Pods. A missing Pod cannot prove a partitioned process
stopped. The helper stops only the selected Helm release's API and worker. For runtime
upgrades, freeze Agent deployments and draft edits. Resolve queued or running
deployments first. Keep restrictions through recovery.

Start in the root of the clean checkout at the reviewed commit. In a dedicated
Bash shell, set the connection and release inputs. Set `OCC_CA_BUNDLE` only
if OCC uses a private certificate authority.

```bash
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/operator-service-key.json'
# export OCC_CA_BUNDLE='/secure/occ/occ-ca.pem'
export RELEASE_SOURCE_SHA='<full-40-character-git-sha>'
export UPGRADE_EVIDENCE="/secure/occ/upgrades/$(date -u +%Y%m%dT%H%M%SZ)"
git rev-parse HEAD
git status --short --untracked-files=all
```

Continue only if `git rev-parse HEAD` reports the reviewed commit and the status
command succeeds with no output. The evidence directory must not exist. The
helper creates it with mode `0700`. Set the target once in the same shell:

```bash
target=(--kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>'
        --namespace openclaw-system --release oce
        --values /secure/occ/values.yaml --installation /secure/occ/installation.yaml
        --source-revision "$RELEASE_SOURCE_SHA" --occ /secure/occ/bin/occ)
```

### Include reviewed settings

Keep `--values` and `--installation` as the current live baseline. For desired
configuration changes, make separate owner-only copies and review the complete
diff against that baseline:

```bash
cp /secure/occ/values.yaml /secure/occ/candidate-values.yaml
cp /secure/occ/installation.yaml /secure/occ/candidate-installation.yaml
chmod 600 /secure/occ/candidate-values.yaml /secure/occ/candidate-installation.yaml
```

These copies may change the
[Slack directory proxy](../integrations/slack.md#configure-both-slack-proxies)
and select the [curated Codex PluginDriver](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
An explicit candidate may also wrap an existing single `drivers.plugin`
registration in a one-element array, preserving its `id` and `configuration`.
The helper does not convert the baseline automatically. Other configuration
changes are not supported by this upgrade command.
Review compatibility with the selected images, Agent drafts and credentials
before the maintenance window; the startup preflight below does not prove
external access.
The command does not change IAM, authentication, Installation identity, database,
bootstrap, native administration, Compute identity or cluster trust, or repository
settings through these candidate files. Repository settings include the GitHub
Backend and registry path, Repo Driver, and Compute credential-service peer.
Select controller and runtime images with their image flags; do not edit those
image fields or the managed Installation checksum in the copies.

Keep the referenced repository registry ConfigMap, broker trust Secrets, and
other external credential-service configuration unchanged through the release
and recovery. The helper compares their references, not their contents; review
them with the [repository installation guide](../repository-credentials/installation.md)
before upgrading.

Add either or both flags to any upgrade command below:

```text
--candidate-values /secure/occ/candidate-values.yaml
--candidate-installation /secure/occ/candidate-installation.yaml
```

The helper saves the reviewed inputs in its private evidence, applies the image
selections and preserved broker endpoint, and writes the final candidate to the
baseline paths during the upgrade. An Installation change also updates its
Secret and restarts OCC with the new checksum. Keep candidate files unchanged
and available at the same paths for recovery.

### Apply other Installation changes

An upgrade keeps your Installation YAML. A candidate that changes any setting
other than these Plugin Driver changes stops the helper with `candidate
Installation changes a protected setting`. Apply other changes, such as newly
recommended resource values, separately with
[apply other Installation changes](production-installation-changes.md).

## Bind the Installation once

Skip this step when the live Installation Secret already has the correct
`openclaw.dev/installation-id` annotation.

After initial production bootstrap, read the Installation ID from the retained
bootstrap key and annotate the Secret:

```bash
export OCC_INSTALLATION_ID="$(jq -er '.meta.installationId' "$OCC_BOOTSTRAP_KEY_FILE")"
export OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)"
kubectl --kubeconfig /secure/occ/kubeconfig \
  --context '<reviewed-context>' --namespace openclaw-system \
  annotate secret "$OCC_INSTALLATION_SECRET" \
  openclaw.dev/installation-id="$OCC_INSTALLATION_ID"
```

Do not replace a different existing ID. Investigate why the cluster and
bootstrap record disagree.

## Rehearse before the maintenance window

`--preflight-only` checks target inputs and applicable repository image pairs,
runs a Helm server dry run, and checks startup in temporary API and worker Pods.
Add this flag to the controller or runtime command below. Use
`--evidence-dir "${UPGRADE_EVIDENCE}-preflight"` for this run. Writers stay
active. After [cleanup](production-upgrade-recovery.md#clean-up-preflight-resources),
run the same command without `--preflight-only` and with the original, unused
`"$UPGRADE_EVIDENCE"` directory.
Live checks repeat. Keep writer and draft freezes through recovery.

Time upgrade and recovery interruptions on an isolated, populated installation.
Use the same command, separate endpoints, a [protected baseline](upgrade-baseline.md),
and fresh evidence.
[Preserve candidate writes](upgrade-baseline.md#restore-the-retained-candidate-database).
Return to software compatible with retained state and schema. Read back an
acknowledged candidate write from the returned service.

## Upgrade the control plane

Releases with the shared tenant namespace refuse to start on a single-cluster
Installation with
[split-layout tenants](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations);
check before the maintenance window.

Set the controller image and run the command without `--runtime-image`:

```bash
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'

scripts/upgrade-production-images "${target[@]}" \
  --controller-image "$CONTROLLER_IMAGE" \
  --evidence-dir "$UPGRADE_EVIDENCE"
```

For a repository-enabled release, set `BROKER_IMAGE` to the selected immutable
broker reference and add `--broker-image "$BROKER_IMAGE"` to this command. Keep
the protected values equal to live values; the helper preserves
the running broker's exact hostname in the candidate. It qualifies the pair
before cluster mutation and verifies the deployed pair and broker capability.

If the startup preflight fails, the old release keeps serving. Inspect the
API and worker preflight logs in the evidence directory. After a cleanup warning
or interruption, preserve the evidence and lock and follow
[preflight cleanup](production-upgrade-recovery.md#clean-up-preflight-resources).

The helper stops the release's API and worker before updating the protected
inputs and Installation Secret. Helm runs migration and bootstrap before it
restores the Deployments. The helper then verifies rollout and OCC access.

Success looks like:

```text
Upgraded controller image; no Agent deployments were requested.
```

## Upgrade Agent runtimes

Set the runtime image and run the command:

```bash
export RUNTIME_IMAGE='<registry>/runtime@sha256:<64-hex-digest>'

scripts/upgrade-production-images "${target[@]}" \
  --runtime-image "$RUNTIME_IMAGE" \
  --evidence-dir "$UPGRADE_EVIDENCE"
```

When repository credentials are enabled, also pass `--controller-image` (current
digest) and `--broker-image` (selected digest). The worker and broker still restart.

Check the preflight warnings. The selected controller image checks saved Agent
Configurations when it supports draft validation and the drafts fit in the
temporary Secret. Otherwise, OCC checks them at deployment. If preflight
refuses a draft, correct it or stop the Agent before running a new preflight.
Driver, credential, plugin and repository checks still run at deployment.

Before mutation, the command requires a complete authorized inventory with no
deployment in progress. Every running Agent must have a readable selected version
in a ready Namespace. A running Agent without one, usually a failed initial
deployment, stops the command before any change; the refusal lists up to ten
such Agents by ID, name, and Namespace. Stop or delete each such Agent, or
deploy it until it succeeds, then start again with a new evidence directory.

The command writes the runtime digest to both Kubernetes Compute image fields,
updates the Installation Secret after quiescing OCC, and runs Helm with the
current controller image.
The Installation checksum restarts the API and worker so they load the new
configuration; their software version does not change.

After OCC recovers, the command deploys every recorded running Agent, waits for
durable success, confirms each new selected version, and requires its Pods to be
`Running` and `Ready` on the requested runtime digest. If OCC refuses an
Agent's deployment, such as for a saved setting the new release refuses, the
command names the Agent and the refusal; correct it and
[resume](production-upgrade-recovery.md#correct-a-refused-agent-deployment).
Stopped and deleting Agents remain untouched. An empty fleet updates the saved
runtime selection but does not prove that the image starts.

OpenClaw runs startup-safe migrations and plugin convergence before each gateway
becomes ready. This workflow replaces immutable images instead of running
`openclaw update`, so the command then runs
`openclaw doctor --lint --json --severity-min error` inside every replacement
gateway, one at a time, each within `--timeout-seconds`. Doctor shares the
gateway's memory limit, so it first waits for free gateway memory; this cannot
reserve memory or guarantee no OOM kill. Doctor is read-only here; a reported
error, or a gateway evicted, replaced, restarted, or not `Ready` after the last
Doctor, fails the upgrade. Doctor output is saved under `status/*.doctor.*`; see
[Doctor recovery](production-upgrade-recovery.md#correct-a-doctor-failure).
Gateways run `doctor --fix` themselves only
for [older state](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).

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

For a controller-only release, confirm gateway readiness after any restarts and
check repository-bound Agents that needed replacement versions. For a runtime
release, inspect `deployments.jsonl`, `status/*.doctor.json`, and the before/after
workload inventories.

[Verify production workloads](production-agents.md#verify-production-workloads)
for each execution mode and provider in use. Require a fresh model response and
check relevant channels, credentials, workspace data, and native UI access.
For retained conversations, reopen the test conversation on the new release,
find the marker and obtain a fresh reply.

After promotion, [verify the served Console](../../release/container-promotion.md#verify-the-served-console).

## Recover from a partial failure

Keep the original evidence directory, the runtime upgrade's sibling
`.dispatch-state` journal, and the applicable maintenance restrictions. If the
terminal disconnected, inspect the `completed` marker and the recorded Helm,
rollout and Agent results. A missing marker leaves the outcome uncertain.

If initialization is unclear, inspect the current Helm initialization Job with
the matching CLI and a trusted kubeconfig that can read the named Job:

```bash
job_target=(--kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>'
            --kube-namespace openclaw-system --release oce)
/secure/occ/bin/occ installation plan "${job_target[@]}"
```

Use `doctor` instead of `plan` for the Job status alone. Both are read-only.
Without a recorded Job UID, the result describes the current Job. See [how to interpret the result](production-handoff.md#resume-an-installation-in-progress).
The Job alone cannot establish the database state or whether the upgrade finished. Follow the [upgrade recovery procedure](production-upgrade-recovery.md)
to reconcile migrations and Agent deployments before deciding whether to resume.

### Roll back across human sign-in

Migration `0037` adds the human sign-in state, and `helm rollback` never reverses it. See [roll back across human sign-in](production-upgrade-recovery.md#roll-back-across-human-sign-in) before any rollback.

## Current limits

- No canary, batching, general runtime compatibility check, automatic rollback,
  or cluster-wide upgrade lock.
- Agent deployments use current drafts rather than recreating selected versions.
- One runtime image is used for both gateway and Agent containers.
- Model, channel, provider, native-access, and restore checks remain manual.

See the [production image upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
