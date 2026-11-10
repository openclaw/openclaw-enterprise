# Upgrade production images

Upgrade Kubernetes Compute Helm installations using the release checkout's
`scripts/upgrade-production-images` and matching [OCC CLI](../cli.md#connect-to-your-installation).
See [production installation](production-installation.md) and
[production Agents](production-agents.md).

1. [Select and prepare the release](#prepare-the-release). Record the live
   baseline; take backups required by the [upgrade checklist](upgrade-checklist.md).
2. [Preflight the target](#rehearse-before-the-maintenance-window).
   [Compare manifests](upgrade-baseline.md#compare-the-candidate-with-the-installed-manifest).
3. Plan traffic handoff and freeze writers. Apply the [control plane](#upgrade-the-control-plane) or
   [runtime](#upgrade-agent-runtimes) upgrade once with fresh evidence.
4. [Verify the release](#verify-the-release) with a real workload.
5. [Recover from a partial failure](#recover-from-a-partial-failure) before retrying.

Use `--controller-image` for the API and worker; add `--broker-image` when repository credentials are enabled. A broker restart can
interrupt existing Agent versions. `--runtime-image` updates the gateway and
runtime image and redeploys every running Agent concurrently. Upgrades stop the
API and worker during migration and rollout. Allow capacity for old
and replacement versions to overlap.

Keep the unchanged checkout exclusive and evidence/baselines outside the chart.
Chart files are verified before cluster access.

Configure endpoint and TLS settings in the selected kubeconfig.
Unset `HELM_KUBEAPISERVER`, `HELM_KUBECAFILE`, `HELM_KUBETLS_SERVER_NAME` and
`HELM_KUBEINSECURE_SKIP_TLS_VERIFY` before starting or resuming.
These override kubeconfig/context flags.

For settings changes, [prepare reviewed candidate files](#include-reviewed-settings).
For the experimental two-cluster profile, first
[upgrade the execution chart](../../testing/kubernetes.md#upgrade-the-execution-chart).

## Prepare the release

For retained conversations, send a unique nonsecret marker through the approved
interface; privately record its Agent and location.

Prepare:

- images pinned by lowercase `@sha256:` digest, with passing checks and a full
  reviewed commit. Use [published digests](../../release/containers.md#prepare-and-publish)
  or build them;
- a clean release checkout at `RELEASE_SOURCE_SHA`. Run the helper from its
  root to check the chart and live Collector configuration;
- the matching OCC CLI at `--occ` (`/secure/occ/bin/occ` below). Use the
  [release binary](../cli.md#connect-to-your-installation) or build it with
  `go build -trimpath -o bin/occ ./cmd/occ` in the release checkout. The CLI reads deployment inventory and deploys Agents;
- a [pre-upgrade baseline](upgrade-baseline.md) of Helm, Kubernetes, OCC and
  database state;
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files;
- Bash, Python 3, Node.js matching the checkout’s `package.json` `engines.node`, Helm, kubectl, jq, yq, cmp and mktemp on the operator host. The Kubernetes identity must
  create and delete Jobs, Secrets and NetworkPolicies; get Jobs and Pods; list Pods;
  read Pod logs; get and patch Deployments; and get Installation Secrets in the
  release namespace. Changing a mutable Secret requires `update` on that name.
  Fresh preparation stops on confirmed denial and warns if access is unverified.
  Staged immutable Secrets remain read-only;
- for the bundled Collector, [refresh its config Secret](../observability.md#refresh-the-collector-configuration-on-upgrade)
  from the release checkout and restart the Collector, even for image-only
  releases. Helm leaves the Secret as is. The helper stops before mutation if
  its `collector.yaml` or `kubernetes.yaml` differs;
- PostgreSQL backups for controller migrations that can require data
  restoration, and Agent-volume backups for runtime releases that can require
  runtime data restoration.

Repository-enabled releases require both `--controller-image` and
`--broker-image`, even when you retain the current digest. Stage the exact operator-trusted
images on a Linux host running as UID 1000. Docker Engine must support platform-specific inspection/export. Install OpenSSL. Every node matching the control-plane selector must match the host's native
`linux/amd64` or `linux/arm64` architecture. Freeze eligible nodes and their labels
during maintenance. The Kubernetes identity must list nodes, read Deployments,
ReplicaSets and Pods, and run a read-only check in the worker container. Local
preflight checks protocol compatibility. Check Kubernetes image availability
and admission, image trust, database durability and session disposal separately.

Inventory requires Installation `read`/`administer` and Namespace/Agent `read`.
Active, desired-running Agents with a selected revision and no pending deployment
also require Agent `deploy` and selected-revision `read`. Runtime upgrades additionally
require Configuration and replacement-revision `read`.

Review runtime drafts; deployments snapshot them.

Every upgrade needs the serving API’s inventory endpoint; controller-only upgrades
also need exact revision reads for retained running Agents.

Controller-only upgrades read each active revision with `occ agent revision`,
refusing missing or unreadable Harness settings before stopping OCC. Plan an
authorized replacement, or stop and settle the Agent before upgrading, then deploy
reviewed drafts. Git session continuity still requires the
[upgrade checklist](upgrade-checklist.md#apply-the-release-in-dependency-order).

For OpenShell, a controller change to the generated Harness command requires a
fresh Agent revision. Existing Sandboxes require the same launch specification;
a controller-only upgrade cannot reuse them with a changed command. Plan an
authorized redeployment from reviewed drafts, even if the runtime image is unchanged.

If a controller-only release changes Pod specs, the new worker restarts affected
Agent Pods once on the same image. A broker restart recreates
dedicated Codex Pods and can leave sessions the worker cannot replace. Plan the
interruption and authorized replacement versions. Review affected Agents'
drafts and deploy grants. Stop if recovery is unsafe. Follow the
[broker recovery procedure](../repository-credentials/installation.md#install-and-verify).

During maintenance, freeze other Helm changes and disable automation, including
autoscalers, that restarts or scales OCC Deployments. Stop other OCC database writers, including
independent API, worker or maintenance processes. Confirm nodes are reachable.
Do not force-delete OCC Pods. A missing Pod cannot prove a partitioned process
stopped. The helper stops only the selected Helm release's API and worker. Freeze
Agent deployments for every upgrade, and draft edits for runtime upgrades. Settle
queued or running deployments first. Keep restrictions through recovery.

In the reviewed checkout, use a dedicated Bash shell. Set `OCC_CA_BUNDLE` only
for a private certificate authority.

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

Continue only if HEAD matches the reviewed commit and status succeeds without
output. The evidence directory must not exist; it is created with mode `0700`. Set the target once in the same shell:

```bash
target=(--kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>'
        --namespace openclaw-system --release oce
        --values /secure/occ/values.yaml --installation /secure/occ/installation.yaml
        --source-revision "$RELEASE_SOURCE_SHA" --occ /secure/occ/bin/occ)
```

### Include reviewed settings

Keep `--values` and `--installation` as the live baseline. Review owner-only copies:

```bash
cp /secure/occ/values.yaml /secure/occ/candidate-values.yaml
cp /secure/occ/installation.yaml /secure/occ/candidate-installation.yaml
chmod 600 /secure/occ/candidate-values.yaml /secure/occ/candidate-installation.yaml
```

Candidate values support [separate migrations](separate-database-upgrade.md) and [immutable Installation Secrets](immutable-installation-upgrade.md).
These copies may change the
[Slack directory proxy](../integrations/slack.md#configure-both-slack-proxies)
and select the [curated Codex PluginDriver](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
An explicit candidate may also wrap an existing single `drivers.plugin`
registration in a one-element array, preserving its `id` and `configuration`.
Remove obsolete `agentNativeAdmin.sharedCookieDomain` only if empty; keep
`auth.baseUrl` and `agentNativeAdmin.domain`, which determine cookie scope, unchanged.
The helper does not convert the baseline automatically. Other configuration changes are unsupported.
Review image, draft and credential compatibility before maintenance; startup
preflight does not prove external access.
Candidate files cannot change IAM, authentication, Installation identity, database credentials,
bootstrap, native administration, Compute identity or cluster trust, or repository
settings, including the GitHub Backend, registry path, Repo Driver and Compute credential-service peer.
Select controller and runtime images with their image flags; do not edit those
image fields or the managed Installation checksum in the copies.

Keep the referenced repository registry ConfigMap, broker trust Secrets, and
other external credential-service configuration unchanged through the release
and recovery. The helper compares their references, not their contents; review
them with the [repository installation guide](../repository-credentials/installation.md)
before upgrading.

Add either or both flags:

```text
--candidate-values /secure/occ/candidate-values.yaml
--candidate-installation /secure/occ/candidate-installation.yaml
```

The helper saves inputs in private evidence, applies image selections and the
preserved broker endpoint, then writes the candidate to the
baseline paths during the upgrade. An Installation change updates its mutable
Secret or selects the staged immutable successor, and restarts OCC with the new checksum. Retain unchanged candidate files
at these paths for recovery.

### Apply other Installation changes

An upgrade keeps your Installation YAML. A candidate that changes any setting
other than these Plugin Driver changes stops the helper with `candidate
Installation changes a protected setting`. Apply other changes, such as newly
recommended resource values, separately with
[apply other Installation changes](production-installation-changes.md).

## Bind the Installation once

After bootstrap, bind the Installation Secret using the retained key. Skip an
already-correct `openclaw.dev/installation-id` annotation:

```bash
(
  set -o pipefail
  OCC_INSTALLATION_ID=$(jq -ser '
    select(length == 1) | .[0].meta.installationId | select(type == "string") |
    select(test("\\Ains_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z"))
  ' "$OCC_BOOTSTRAP_KEY_FILE") &&
  OCC_INSTALLATION_SECRET=$(yq -o=json '.' /secure/occ/values.yaml | jq -ser '
    select(length == 1) | .[0] | objects | .installation.secretName |
    if . == null then "occ-installation-startup" else . end |
    select(type == "string" and length <= 253) |
    select(test("\\A[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\\z"))
  ') || { printf '%s\n' 'Invalid inputs; annotation unchanged.' >&2; exit 1; }
  kubectl --kubeconfig /secure/occ/kubeconfig \
    --context '<reviewed-context>' --namespace openclaw-system \
    annotate secret "$OCC_INSTALLATION_SECRET" \
    openclaw.dev/installation-id="$OCC_INSTALLATION_ID"
)
```

Never overwrite a different ID; reconcile cluster and bootstrap records.

## Rehearse before the maintenance window

Add `--preflight-only --evidence-dir "${UPGRADE_EVIDENCE}-preflight"` to either
upgrade command. With writers active, it checks inputs, repository image pairs,
Helm's server dry run, and startup in temporary API/worker Jobs.
Their controller-owned Pods retain chart security and NetworkPolicy labels.
Unconfirmed Job or child cleanup blocks Secret/policy removal and the upgrade.

With an immutable Installation Secret, keep the live configuration or
[stage an immutable successor](immutable-installation-upgrade.md) before preflight.

After [cleanup](production-upgrade-recovery.md#clean-up-preflight-resources),
omit `--preflight-only` and use the unused `"$UPGRADE_EVIDENCE"`. Live checks
repeat. Retain writer and draft freezes through recovery.

Time both interruptions on an isolated, populated installation using separate
endpoints, the same command, a [protected baseline](upgrade-baseline.md), and
fresh evidence. [Preserve candidate writes](upgrade-baseline.md#restore-the-retained-candidate-database).
Return to software compatible with retained state and schema, then read back an
acknowledged candidate write.

## Upgrade the control plane

Before maintenance, check for [split-layout tenants](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations).
Shared-namespace releases refuse this single-cluster layout.

Add `--controller-compatibility-results /secure/occ/controller-results.json` with
`--controller-image` to require the native PostgreSQL `run` result from
[released-controller qualification](../../testing/postgresql.md#released-controller-compatibility).
Before shutdown, both the database-write and configured IAM activation cases must
pass, including cleanup, for the exact image digests. Index, manifest and config
digests are distinct.

[Recovery retains the receipt](production-upgrade-recovery.md). Verify its provenance:
`sourceSha` identifies the test checkout, not image revisions or worktree cleanliness.
These checks do not qualify online migration or rollback; writers still stop.

Omit `--runtime-image`:

```bash
export CONTROLLER_IMAGE='<registry>/controller@sha256:<64-hex-digest>'

scripts/upgrade-production-images "${target[@]}" \
  --controller-image "$CONTROLLER_IMAGE" \
  --evidence-dir "$UPGRADE_EVIDENCE"
```

For repository-enabled releases, add `--broker-image "$BROKER_IMAGE"` with the
selected immutable broker reference. Keep protected values equal to live values;
the helper preserves the broker hostname, qualifies the pair before mutation,
and verifies the deployed pair and broker capability.

Check one running Agent with `--verify-agent AGENT_ID --verify-agent-namespace NAMESPACE_ID`.
This requires [runtime inspection](../../reference/cli.md#runtime-status-and-logs),
exact Agent `read`/`operate` and active AgentRevision `read`, verified before shutdown.
Freeze that Agent's deployment, stop and deletion through verification.
This option cannot accompany `--runtime-image`, which changes revisions.

Completion requires the original active revision, Ready workload roles and any
observed provider Harness still running. Replacement Pod UIDs are allowed.
This samples readiness, not routing, model or channel availability. A final-check failure leaves
the upgraded control plane without `completed`; follow
[recovery](production-upgrade-recovery.md#resume-an-unfinished-prepared-upgrade).

If the startup preflight fails, the old release keeps serving. Inspect the
API and worker preflight logs in the evidence directory. After a cleanup warning
or interruption, preserve the evidence and lock and follow
[preflight cleanup](production-upgrade-recovery.md#clean-up-preflight-resources).

The helper stops both writers before updating protected inputs or replacing changed mutable Secret data.
Helm migrates or [verifies a separate database deployment](separate-database-upgrade.md), bootstraps, and restores Deployments.

```text
Upgraded controller image; no Agent deployments were requested.
```

## Upgrade Agent runtimes

```bash
export RUNTIME_IMAGE='<registry>/runtime@sha256:<64-hex-digest>'

scripts/upgrade-production-images "${target[@]}" \
  --runtime-image "$RUNTIME_IMAGE" \
  --evidence-dir "$UPGRADE_EVIDENCE"
```

When repository credentials are enabled, also pass `--controller-image` (current
digest) and `--broker-image` (selected digest). The worker and broker still restart.

Check preflight warnings. The selected controller image checks saved Agent
Configurations when it supports draft validation and the drafts fit in the
temporary Secret. Otherwise, OCC checks them at deployment. If preflight
refuses a draft, correct it or stop the Agent before running a new preflight.
Deployment still checks Drivers, credentials, plugins and repositories.

Before mutation, the command requires a complete authorized inventory with no
deployment in progress. Every running Agent must have a readable selected version
in a ready Namespace. A running Agent without one, usually a failed initial
deployment, stops the command before any change; the refusal lists up to ten
such Agents by ID, name, and Namespace. Stop or delete each such Agent, or
deploy it until it succeeds, then start again with a new evidence directory.

The command writes the runtime digest to both Kubernetes Compute image fields,
updates the mutable Installation Secret or selects its staged immutable successor,
and runs Helm after quiescing OCC with the
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
runtime selection without proving image startup.

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

```text
Upgraded runtime image; controller image remained unchanged and <count> running Agents selected new revisions.
```

To release both images together, pass both image options. The command applies
both changes in one Helm release before deploying the recorded fleet.

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
