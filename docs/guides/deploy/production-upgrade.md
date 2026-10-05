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
[upgrade migration checklist](upgrade-checklist.md) so persisted control-plane,
Driver, runtime, and cluster-owned state has an explicit disposition.

To release reviewed settings with an image, pass separate candidate values
and Installation files as described below. The baseline files must match live
state, including image fields. The command rejects unexpected drift rather than
incorporating it into a release.

The command supports the production Helm and Kubernetes Compute path. It does
not build images, create backups, provision infrastructure, or prove model and
external integration behavior.

## Prepare the release

Prepare:

- each selected image as an immutable `@sha256:` digest with passing checks and
  a reviewed source commit;
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
  create and delete Pods and Secrets and read Pod logs in the release namespace;
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

Restarting the repository broker loses delivered sessions. Before a release,
plan interruption and authorized replacement revisions for affected Agents;
review their drafts and deploy grants. Stop if recovery cannot be performed
safely. A lost delivered session fails its revision and queues retirement;
inspect its retained cleanup. A controller-only release does not request
replacements. Follow the
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
Review compatibility with the selected images and existing Agent drafts and
credentials before the maintenance window. Rendering and the Helm dry run do
not validate the Installation's Driver configuration or prove external access.
The command does not change IAM, authentication, Installation identity, database,
bootstrap, native administration, Compute identity or cluster trust, or repository
settings through these candidate files. Repository settings include the GitHub
Backend and registry path, Repo Driver, and Compute credential-service peer.
Select controller and runtime images with their image flags; do not edit those
image fields or the managed Installation checksum in the copies.

Keep the referenced repository registry ConfigMap, broker trust Secrets, and
other external credential-service configuration unchanged through the release
and recovery. The helper compares their configured references, not the contents
of those Kubernetes resources. Follow the
[repository installation guide](../repository-credentials/installation.md) to
review their identity and policies before upgrading.

Add either or both flags to any upgrade command below:

```text
--candidate-values /secure/occ/candidate-values.yaml
--candidate-installation /secure/occ/candidate-installation.yaml
```

The helper saves the reviewed inputs in its private evidence, applies the image
selections and preserved broker endpoint, and writes the final candidate to the
baseline paths during the upgrade. An Installation change also updates its
Secret and restarts OCC with the new checksum. A controller-only release still
does not deploy Agents; plan any Agent changes separately. Keep candidate files
unchanged and available at the same paths for recovery.

### Apply other Installation changes

An upgrade keeps your Installation YAML. A release that changes recommended
Installation values, such as the Gateway and Harness memory requests and limits
in the [installation profiles](installation-profiles.md) and production example,
does not change an existing Installation; adopted resource values apply to each
Agent at its next deployment. A candidate that changes any setting other
than the Plugin Driver selection stops the helper with `candidate Installation
changes a protected setting`. Diff `deploy/examples/production/installation.yaml`
and `scripts/render-installation-profile.mjs` between the deployed and candidate
source, decide which changes to adopt, and apply them as a separate change, not
during an image upgrade. Run these commands from a checkout of the installed
controller's source revision, not the release checkout, and keep the image
references in `values.yaml` unchanged:

```bash
set -euo pipefail
cd /secure/src/openclaw-enterprise-installed # checkout of the deployed source revision
cp /secure/occ/installation.yaml /secure/occ/installation.yaml.before
# Edit /secure/occ/installation.yaml and review the diff, then:
yq -r '.presets.files[]?' /secure/occ/installation.yaml | while read -r preset_file; do
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system exec deploy/openclaw-enterprise-api --container api -- \
    sh -c 'cd "$(dirname "$OCC_CONFIG_PATH")" && test -f "$1" && test -r "$1"' sh "$preset_file" ||
    { echo "Could not verify Preset file $preset_file in the API container." >&2; exit 1; }
done
export OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)"
export OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' /secure/occ/values.yaml)"
jq -n --arg key "$OCC_INSTALLATION_KEY" --rawfile document /secure/occ/installation.yaml \
  '{data: {($key): ($document | @base64)}}' |
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system patch secret "$OCC_INSTALLATION_SECRET" \
    --type merge --patch-file /dev/stdin
OCC_CHECKSUM="$(sha256sum /secure/occ/installation.yaml | cut -d ' ' -f 1)" \
  yq -i '.controlPlane.installationChecksum = strenv(OCC_CHECKSUM)' /secure/occ/values.yaml
helm upgrade oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig --kube-context '<reviewed-context>' \
  --namespace openclaw-system -f /secure/occ/values.yaml --wait --timeout 5m
```

The new checksum restarts the API and worker so they read the new Installation.
This path has no startup preflight, and the API stops before its replacement
starts: an Installation the controller rejects keeps the API down, with a
`startup-error` code such as `PRESET_FILE_INVALID`, until you undo the change.
The Preset loop checks file readability, not contents. Helm reports a rejection
only after its 5-minute timeout; the API log shows `startup-error` sooner, but
let Helm return before you undo.
The patch replaces only the Installation key and keeps the Secret's
`openclaw.dev/installation-id` annotation. Do not re-create the Secret with
`kubectl apply`: if its last applied configuration carries that annotation,
apply deletes it and the next upgrade refuses the Secret. Settings that
shape Agent Pods, such as Gateway resources, apply only to Pods created
afterward; deploy an Agent to apply them to it. To undo, restore the `.before`
file and rerun the Secret patch, checksum and `helm upgrade` commands; skip the
loop, which needs a running API container. The edited files are the baseline for
the next upgrade.

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
temporary Secret. Each loads the Installation, Drivers and `presets.files` as
startup does, without opening the database. If either fails, as when a listed
Preset file is missing from the image, the command waits for both Pods, prints
each failure, deletes the Pods and Secret, and stops; the old release keeps
serving. Each Pod's log and status are saved as `preflight-<api|worker>.log` and
`preflight-<api|worker>-status.json`; saving them can run up to about 90 seconds
past `--timeout-seconds`. Runtime upgrades run it on the current controller image. If
the helper is killed first, delete what it left with
`kubectl delete pod,secret -n <namespace> -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=upgrade-preflight`.

The command then applies reviewed settings, scales the API and worker to zero, and
waits for their Pods to terminate. Helm restores the candidate Deployments after
its initialization hooks succeed. The helper verifies rollout and OCC access.

Helm runs the candidate controller's database migration init container with the
migration role, then runs bootstrap. The API and worker do not roll out unless
both hooks succeed. The command does not request fleet inventory or Agent
deployment authority. A replacement revision snapshots the current draft; it
does not settle old cleanup or replay repository operations.

For the first release that introduces `occ installation deployment-inventory`,
verify that operation after the controller upgrade before attempting a runtime
upgrade.

Success looks like:

```text
Upgraded controller image; no Agent deployments were requested.
```

This result confirms the helper's rollout, not recovery of repository-bound
Agents. Verify those Agents and their required repository operations separately.

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

When repository credentials are enabled, also pass `--controller-image` with
the current controller digest and `--broker-image` with the selected broker
digest. The worker and broker still restart during this release.

Before mutation, the command requires a complete authorized inventory with no
deployment in progress. Every running Agent must have a readable active revision
in a ready Namespace.

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

For a controller-only release, confirm unaffected gateways remain ready and
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
