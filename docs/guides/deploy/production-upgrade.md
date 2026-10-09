# Upgrade production images

Use `scripts/upgrade-production-images` to release the OpenClaw Control Plane
(OCC), Agent runtimes, or both. Select the images you intend to change:

- `--controller-image` updates the OCC API and worker without requesting Agent
  deployments. A restarted repository broker can interrupt existing revisions.
- `--runtime-image` keeps the current controller image, updates the gateway and
  Agent runtime image, and deploys a new revision for every running Agent.
- `--broker-image` selects the repository broker when credentials are enabled.

Every release stops the OCC API and worker during migration and rollout. Runtime
upgrades also restart the fleet concurrently. Schedule an interruption window
and provide enough capacity for old and replacement revisions to overlap.
Before either kind of release, complete the
[upgrade checklist](upgrade-checklist.md).

To release reviewed settings with an image, pass separate candidate values
and Installation files as described below. The baseline files must match live
state, including image fields. The command rejects unexpected drift rather than
incorporating it into a release.

The command supports the production Helm and Kubernetes Compute path. It does
not build images, create backups, provision infrastructure, or prove model and
external integration behavior. It upgrades only the `openclaw-enterprise` chart:
on the experimental two-cluster profile, first
[upgrade the execution chart](../../testing/two-cluster-local.md#upgrade-the-execution-chart).

## Prepare the release

Prepare:

- each selected image as an immutable lowercase `@sha256:` digest with passing
  checks and a reviewed source commit;
- a clean checkout of the release you are installing, at `RELEASE_SOURCE_SHA`.
  Run the helper from its root: it renders that checkout's Helm chart and
  compares the Collector configuration with that checkout's files;
- the OCC CLI from the same release, installed at the path you pass as `--occ`
  (`/secure/occ/bin/occ` below): its
  [release binary](../cli.md#connect-to-your-installation), or `bin/occ` from
  `pnpm cli:build` in that checkout. The helper reads the deployment inventory
  and deploys Agents through it, and an older CLI can lack those commands;
- a [pre-upgrade baseline](upgrade-baseline.md) of Helm, Kubernetes, OCC and
  database state;
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files;
- Node.js, which builds the startup preflight Pods; its Kubernetes identity must
  create and delete Pods, Secrets and NetworkPolicies and read Pod logs in the
  release namespace;
- with the bundled Collector enabled, its config Secret
  [refreshed](../observability.md#refresh-the-collector-configuration-on-upgrade)
  from this checkout and the Collector restarted, even for an image-only
  release. Helm does not update the Secret, and the helper stops before mutation
  when its `collector.yaml` or `kubernetes.yaml` differs;
- a PostgreSQL backup before a controller release whose migrations may require
  data restoration; and
- Agent-volume backups before a runtime release whose recovery may require
  restoring runtime data.

For repository-enabled releases, supply both `--controller-image` and
`--broker-image`, even when retaining the current digest. Stage the exact
operator-trusted images locally on a Linux host running as UID 1000. Docker
Engine must support platform-specific image inspection and export; Python 3,
Node.js, and OpenSSL must be available. Every node matching the control-plane
selector must use the host's single native `linux/amd64` or `linux/arm64`
architecture. Freeze eligible nodes and their labels during the maintenance
window. The Kubernetes identity must list nodes and read Deployments,
ReplicaSets and Pods, and execute a read-only check in the worker container.
The local preflight checks protocol compatibility, not Kubernetes image
availability or admission, image trust, database durability, or session disposal.

The OCC identity needs Installation `read`. A runtime upgrade additionally needs
Installation `administer`, exact `read` access to every Namespace, Agent, and
active Agent revision, plus exact `deploy` access to every running Agent.
Revision read access must also cover the replacement revisions.

Review saved Agent and Configuration drafts before a runtime upgrade. Each
deployment snapshots the current draft, not the previous active revision.

A controller-only release does not deploy Agents, but the new worker can
restart their Pods once
([details](breaking-changes.md#2026-10-10-controller-only-releases-can-restart-agent-pods-once)).
Restarting the repository
broker loses delivered sessions. Before a release,
plan interruption and authorized replacement revisions for affected Agents;
review their drafts and deploy grants. Stop if recovery cannot be performed
safely. A lost delivered session fails its revision and queues retirement;
inspect its retained cleanup. Follow the
[broker recovery procedure](../repository-credentials/installation.md#install-and-verify).

Stop other Helm changes until the command completes. Disable autoscalers and
other automation that can restart or scale the OCC Deployments. Stop any other
process that writes to the OCC database, including independent API, worker, or
maintenance processes. Confirm nodes are reachable and do not force-delete OCC
Pods: a missing Pod alone cannot prove a partitioned process stopped. The helper
stops the selected Helm release's API and worker and waits for their Pods to
terminate; it cannot stop or detect other database writers. For a runtime upgrade,
also stop Agent deployments and draft edits, and resolve queued or running Agent
deployments first. Keep these restrictions in place through recovery.

Set the shared inputs:

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
test -z "$(git status --porcelain)" || echo 'The release checkout is not clean.' >&2
```

The evidence directory must not exist. The command creates it with mode `0700`.

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
Other configuration changes are not supported by this upgrade command.
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
other than the Plugin Driver selection stops the helper with `candidate
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

## Upgrade the control plane

Releases with the shared tenant namespace refuse to start on a single-cluster
Installation with
[split-layout tenants](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations);
check before the maintenance window.

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

For a repository-enabled release, set `BROKER_IMAGE` to the selected immutable
broker reference and add `--broker-image "$BROKER_IMAGE"` to this command. Keep
the protected values equal to live values; the helper preserves
the running broker's exact hostname in the candidate. It qualifies the pair
before cluster mutation and verifies the deployed pair and broker capability.

Before it stops anything, the command runs a startup preflight: one-shot API and
worker Pods on the selected controller image, built from the rendered chart (same
environment, mounts and service account), with the candidate Installation in a
temporary Secret and the chart's API and worker dependency egress in a temporary
NetworkPolicy. Each loads the Installation, Drivers and `presets.files`, then
runs the bundled Kubernetes Compute Driver's preflight as startup does, without
opening the database. Each then checks the stored Installation name, which the
command reads through OCC, against the image's Name rule. If either fails, as
when a listed Preset file is missing from the image, split-layout tenants remain
or the name
[breaks the rule](production-upgrade-recovery.md#correct-an-invalid-installation-name),
the command prints each failure, deletes these resources, and stops; the old
release keeps serving. Logs and
status are saved as `preflight-<api|worker>.log` and `-status.json`, taking up
to about 90 seconds past `--timeout-seconds`. Runtime upgrades use the current
controller image. If the helper is killed, delete its leftovers with
`kubectl delete pod,secret,networkpolicy.networking.k8s.io -n <namespace> -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=upgrade-preflight`.

The command then applies reviewed settings, scales the API and worker to zero, and
waits for their Pods to terminate. Helm restores the candidate Deployments after
its initialization hooks succeed. The helper verifies rollout and OCC access.

Helm runs the candidate controller's database migration init container with the
migration role, then runs bootstrap. The API and worker do not roll out unless
both hooks succeed. The command does not request fleet inventory or Agent
deployment authority. A later replacement revision does not settle old cleanup
or replay repository operations.

For the first release that introduces `occ installation deployment-inventory`,
verify that operation after the controller upgrade before attempting a runtime
upgrade.

Success looks like:

```text
Upgraded controller image; no Agent deployments were requested.
```

## Upgrade Agent runtimes

Set the runtime image and run the command:

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

When repository credentials are enabled, also pass `--controller-image` (current
digest) and `--broker-image` (selected digest). The worker and broker still restart.

Before mutation, the command requires a complete authorized inventory with no
deployment in progress. Every running Agent must have a readable active revision
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
durable success, confirms each new active revision, and requires its Pods to be
`Running` and `Ready` on the requested runtime digest. Stopped and deleting
Agents remain untouched. An empty fleet updates the saved runtime selection but
does not prove that the image starts.

OpenClaw runs startup-safe migrations and plugin convergence before each gateway
becomes ready. This workflow replaces immutable images instead of running
`openclaw update`, so the command then runs
`openclaw doctor --lint --json --severity-min error` inside every replacement
gateway. Doctor is read-only here; a reported error fails the upgrade and is
saved under `status/*.doctor.*`. Gateways run `doctor --fix` themselves only
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

For a controller-only release, confirm gateways are ready again (affected Agents
restart once) and
verify any repository-bound Agents that required replacement revisions. For a runtime release, inspect
`deployments.jsonl`, `status/*.doctor.json`, and the before/after workload
inventories. Then follow
[Verify production workloads](production-agents.md#verify-production-workloads)
for every execution mode and provider used by the fleet. Require a fresh model
response and check relevant channels, credentials, workspace data, and native UI
access. Doctor lint proves that OpenClaw found no error-level diagnostic; it does
not prove those application paths.

## Recover from a partial failure

Keep the evidence directory and maintenance restrictions, and do not start another upgrade. [Recover a partial production upgrade](production-upgrade-recovery.md) covers resuming the helper, uncertain migrations, unknown Agent dispatches and older images.

### Roll back across human sign-in

Migration `0037` adds the human sign-in state, and `helm rollback` never reverses it. See [roll back across human sign-in](production-upgrade-recovery.md#roll-back-across-human-sign-in) before any rollback.

## Current limits

- No canary, batching, general runtime compatibility check, automatic rollback,
  or cluster-wide upgrade lock.
- Runtime upgrades start all recorded Agent deployments concurrently.
- Agent deployments use current drafts rather than recreating active revisions.
- One runtime image is used for both gateway and Agent containers.
- Model, channel, provider, native-access, and restore checks remain manual.

See the [production image upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
