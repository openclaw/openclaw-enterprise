# Upgrade production images

Upgrade [Kubernetes Compute releases](production-installation.md) using
`scripts/upgrade-production-images` and matching [OCC CLI](../cli.md#connect-to-your-installation).
[Preprovisioned Namespace canaries](../../reference/drivers/kubernetes-compute/preprovisioned-namespace.md)
lack the required chart-owned initializer.

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

Keep the checkout unchanged and exclusive; evidence/baselines stay outside the chart.
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
interface. Privately record its Agent and location.

Prepare:

- images pinned by lowercase `@sha256:` digest, with passing checks and a full
  reviewed commit. Use [published digests](../../release/containers.md#prepare-and-publish)
  or build them;
- a clean release checkout at `RELEASE_SOURCE_SHA`. Run the helper from its root;
- the matching OCC CLI at `--occ` (`/secure/occ/bin/occ` below). Use the
  [release binary](../cli.md#connect-to-your-installation) or run
  `go build -trimpath -o bin/occ ./cmd/occ` in the release checkout;
- a [pre-upgrade baseline](upgrade-baseline.md) of Helm, Kubernetes, OCC and
  database state;
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files;
- Bash, Python 3, Node.js matching `package.json` `engines.node`, Helm, kubectl,
  jq, yq, cmp and mktemp. Use an identity authorized for the Helm upgrade.
  The helper lists Deployments, StatefulSets, Pods and PVCs cluster-wide.
  In the release namespace, it creates and deletes preflight Jobs, Secrets and
  NetworkPolicies, gets and lists Jobs, reads Pods, Pod logs and Installation
  Secrets, and gets, patches and watches Deployments. Rendered cert-manager
  Certificates require server-side dry-run apply. Changed mutable Installation
  Secrets require `update` on the named Secret. Confirmed update denial stops
  preparation. Unverified update access triggers a warning. Staged immutable
  Secrets remain read-only;
- for the bundled Collector, the upgrade helper identity needs Kubernetes `get`
  on the configured config Secret in the release namespace.
  [Refresh its config Secret](../observability.md#refresh-the-collector-configuration-on-upgrade)
  from the release checkout and restart the Collector even for image-only
  releases. Differences in `collector.yaml` or `kubernetes.yaml` stop preparation.
  Use `--collector-config-reviewed` only for intentional, reviewed differences.
- PostgreSQL backups for controller migrations and Agent-volume backups for
  runtime releases that can require data restoration.

Repository-enabled releases require `--controller-image` and `--broker-image`,
even for unchanged digests. Stage trusted images as UID 1000 on Linux with OpenSSL
and Docker Engine supporting platform-specific inspection and export. Nodes
matching the control-plane selector must share the host's native `linux/amd64`
or `linux/arm64`. Freeze those nodes and labels. The helper lists Nodes and
release namespace ReplicaSets and runs a read-only worker exec check. Local preflight checks protocol compatibility. Check image availability,
admission, image trust, database durability and session disposal separately.

The serving API must return a complete deployment inventory, even for an empty fleet.
Use an Installation-scoped OCC service key with Installation `read` and
`administer` and `read` on every Namespace and Agent. Active, desired-running
Agents with a selected revision and no pending deployment also require Agent
`deploy` and selected AgentRevision `read`.

Before shutdown, controller-only upgrades require readable saved Harness settings
from `occ agent revision` and an accepted
[repository restart disposition](../../reference/repository-credentials/worker-replacement.md)
for each retained running Agent. Missing assessments, including from older
controllers, block retention. Stop and settle affected Agents under an authorized
interruption or plan normal runtime replacement. If the pre-stop inventory
changes, prepare again. Check
[Git session continuity](upgrade-checklist.md#record-the-starting-state) and
[apply the release in order](upgrade-checklist.md#apply-the-release-in-dependency-order).

For runtime upgrades, review drafts. The OCC key needs Configuration and
replacement AgentRevision `read`. Doctor needs Kubernetes reads of replacement
Pods and gateway exec.

For OpenShell, changed Harness commands require fresh Agent revisions. Existing
Sandboxes require the original launch specification. Plan an authorized
redeployment from reviewed drafts, even with an unchanged runtime image.

Changed Pod specs in controller-only releases restart affected Agent Pods once on
the same image. A broker restart recreates dedicated Codex Pods and can leave
sessions the worker cannot replace. Plan the interruption and authorized
replacements. Review affected drafts and deploy grants. Stop if recovery is
unsafe. Follow the
[broker recovery procedure](../repository-credentials/installation.md#install-and-verify).

Freeze other Helm changes and disable automation that restarts or scales OCC
Deployments, including autoscalers. Stop other writers to this Installation’s OCC
database, including independent APIs, workers and maintenance processes. Confirm nodes are reachable.
Do not force-delete OCC Pods. Verify that a partitioned process stopped even if
its Pod is gone. The helper stops only the selected release's API and worker.
Freeze Agent deployments and settle queued or running work. Freeze draft edits
for runtime upgrades. Keep these restrictions through recovery.

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
Remove retired `agentNativeAdmin.sharedCookieDomain` whatever its value; keep
`auth.baseUrl` and `agentNativeAdmin.domain`, which determine cookie scope, unchanged.
The helper does not convert the baseline automatically. Other configuration changes are unsupported.
Review image, draft and credential compatibility before maintenance; startup
preflight does not prove external access.
Candidate files cannot change IAM, authentication, Installation identity, database credentials,
bootstrap, native administration, Compute identity or cluster trust, or repository
settings, including the GitHub Backend, registry path, Repo Driver and Compute credential-service peer.
Select images with their flags; do not edit image fields or the managed
Installation checksum in candidate files.

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

The helper saves private evidence, applies selected images and the preserved
broker endpoint, then writes to `--values` and, if changed, `--installation`.
Installation changes update the mutable Secret or select its staged immutable
successor and restart OCC with the new checksum. Keep supplied candidate files
unchanged for recovery.

### Apply other Installation changes

Unsupported candidate settings stop the helper with `candidate
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
Helm's server dry run, rendered Certificate admission, then startup and migration
compatibility in temporary Jobs.
The migration Job uses the candidate controller, initializer's migrator credential/CA, and `scripts/migrate-production.mjs --check`. Recognized pending history
is allowed; migrations are not applied. The Helm hook rechecks history; separate
migrations require completion with `--require-current`.

Pods retain chart security and NetworkPolicy labels. Unconfirmed Job or child
cleanup blocks Secret/policy removal and upgrade.

With an immutable Installation Secret, keep the live configuration or
[stage an immutable successor](immutable-installation-upgrade.md) before preflight.

After [cleanup](production-upgrade-recovery.md#clean-up-preflight-resources),
omit `--preflight-only` and use unused `"$UPGRADE_EVIDENCE"`. Checks repeat.
Keep writer and draft freezes through recovery.

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

Initial preflight failure leaves writers serving; inspect `preflight-<api|worker|migration>.log`.
Failed resume prevents further shutdown; writers may already be stopped. Inspect
current `migration-preflight-resume.*` evidence. Preserve evidence and lock;
follow [preflight cleanup](production-upgrade-recovery.md#clean-up-preflight-resources).

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

Check preflight warnings. The controller image checks saved Agent Configurations
if it supports draft validation and the drafts fit in the temporary Secret.
Otherwise, OCC checks them at deployment. Correct refused drafts or stop their
Agents before retrying. Deployment checks Drivers, credentials, plugins and repositories.

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
Agent's deployment, the command names the Agent and the refusal; correct it and
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

Keep evidence private. Match `source-revision` to the target source commit,
`.id` in `installation-after.json` to the expected Installation ID, and `.version`
in `after-helm-status.json` to this upgrade's deployed Helm revision.
The `completed` marker confirms Helm revision, API and worker rollout,
authenticated Installation access, and any selected
[replacement fleet checks](#upgrade-agent-runtimes) or
[optional continuity check](#upgrade-the-control-plane).
For errors or a missing marker, [recover before retrying](production-upgrade-recovery.md).

Confirm current readiness with [monitoring](production-handoff.md#connect-alerts-to-a-response)
or manual checks. Before ending the interruption window, complete the
[retained installation checks](upgrade-checklist.md#verify-the-retained-installation)
with passing post-rollout results for the target release and expected Agent
revision. Use manual checks for missing, stale, or inconclusive synthetic evidence. Investigate failures and reconcile uncertain writes before
repeating checks.

To check continuity, reopen the test conversation, find its marker, and get a
fresh reply.

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
- Verify functional workflows and restores separately.

See the [production image upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
