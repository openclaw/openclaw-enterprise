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
- the production kubeconfig, Helm values, Installation YAML, OCC service key,
  and optional CA bundle in protected files;
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

For a repository-enabled release, set `BROKER_IMAGE` to the selected immutable
broker reference and add `--broker-image "$BROKER_IMAGE"` to this command. Keep
the protected values equal to live values; the helper preserves
the running broker's exact hostname in the candidate. It qualifies the pair
before cluster mutation and verifies the deployed pair and broker capability.

The command applies reviewed settings, scales the API and worker to zero, and
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

Keep the evidence directory and maintenance restrictions.
Do not start another upgrade to recover: its frozen Agent
inventory and dispatch records are needed to avoid duplicate deployments. If
preparation did not finish, the helper stopped before mutation; use a new
evidence directory after resolving the failure. Otherwise, repeat the original
command with the same arguments, protected file paths, kubeconfig contents,
OCC URL, scripts, flow, and chart, adding `--resume`. The helper rechecks the
recorded image pair and eligible nodes. Include the original candidate
flags and keep their files semantically unchanged. The helper uses the recorded
candidate, reads the live Secret and Helm release, accepts only the recorded
baseline or candidate, and continues the recorded fleet. It rejects unrelated drift. The evidence includes
Secret contents and must remain private.

If a killed process leaves `.upgrade-lock`, first establish that no helper or
its child commands are still running, then remove that empty directory and
resume. This lock covers only processes sharing this evidence directory; it
cannot stop other operators or automation.

A Helm failure or disconnected response does not prove that the migration
rolled back. Read the current Helm status and history, inspect the initialization
Job and its Pods and logs, and inspect the retained database. The saved
`current-helm-status.json` is the last read and can predate the failed request.
A `pending-*` Helm release must be resolved separately before the helper can
continue. Do not start the old API or worker against a migrated database. If the
candidate Helm revision is deployed, the helper reads it back and continues
without rerunning Helm. Otherwise, wait
until the initialization Job and its Pods are terminal, then run the **candidate controller
image** with `node scripts/migrate-production.mjs --check` against the same
retained database, using its dedicated migrator credential and required database
CA in an authorized environment. Keep its exit-zero `migration.checked` output in
private evidence. Follow [migration history](../../reference/settings/operations.md#migration-history)
to interpret unsupported or uncertain state. Only after this check and review of
the Job outcome, repeat the command with `--resume --migration-history-checked`.
That flag records your attestation; it does not run the database check. The
helper keeps or returns OCC to zero replicas before retrying the candidate Helm
release. Prefer a reviewed forward fix; neither Helm rollback nor the helper
reverses committed migrations.

For an unknown Agent dispatch, the helper saves an Agent readback and stops
without replaying it. Inspect the exact Agent's authorized revision history,
deployment status, and audit records, and allow any in-flight request to finish.
An unchanged active revision alone does not prove rejection, and a filtered
revision list does not prove absence. If you can identify the accepted revision,
record a private `dispatch/<same-prefix-as-intent>.json` containing its `id`;
the helper checks that exact deployment's status on resume. If evidence proves
the request was not accepted, deploy that Agent once with the ordinary OCC CLI
and save its successful JSON response under that name. Preserve the `.intent`,
error, and readback evidence. If the result is still uncertain, stop and
investigate rather than submitting another request. For a known failed revision,
inspect its failure and explicitly deploy an authorized replacement before
recording that replacement's response; preserve the original response separately.
Each deployment snapshots current drafts.

For an accepted revision, set `OCC_NAMESPACE` and `OCC_AGENT` to the exact
Agent IDs, `DISPATCH_PREFIX` to the matching evidence path without `.intent` or
`.json`, and `REVISION_ID` to the independently confirmed revision. Verify the exact Agent and deployment before recording it:

```bash
if occ --output json --namespace "$OCC_NAMESPACE" agent deployment-status "$OCC_AGENT" "$REVISION_ID" > "$DISPATCH_PREFIX.confirmed-status.json" &&
  jq -e --arg namespace "$OCC_NAMESPACE" --arg agent "$OCC_AGENT" --arg revision "$REVISION_ID" \
    '.namespaceId == $namespace and .agentId == $agent and .deploymentId == $revision' "$DISPATCH_PREFIX.confirmed-status.json" &&
  test ! -e "$DISPATCH_PREFIX.json" &&
  jq -n --arg id "$REVISION_ID" '{id: $id}' > "$DISPATCH_PREFIX.json.tmp"; then
  mv "$DISPATCH_PREFIX.json.tmp" "$DISPATCH_PREFIX.json"
else
  printf '%s\n' 'Deployment could not be confirmed; do not resume.' >&2
fi
```

Keep the shell's `umask 077`. If the status read is denied or does not identify
the confirmed deployment, do not create the response file. The helper rechecks
its status on resume; it does not verify how you identified an accepted request.

Before selecting an older controller or runtime image, verify it can read all
state written by the candidate and restore compatible data if required. Never
delete Agents, revisions, PVCs, or the bootstrap volume to force recovery.

### Roll back across human sign-in

Migration `0037` adds the human sign-in state. `helm rollback` skips the
pre-upgrade migration Job, so it never reverses that migration.

Before GitHub sign-in is activated, scale `deployment/openclaw-enterprise-api` to
zero and wait for its Pods to disappear, run `helm rollback`, then verify password
sign-in before reopening ingress.

After activation, do not roll back; fix forward. The database refuses sessions
that the previous controller issues without a human sign-in binding, so it
cannot sign anyone in, and existing sessions expire within 8 hours. Never run
the previous and current controllers together.
To roll back anyway, first return to password-only sign-in with
[stopped maintenance](auth-maintenance.md#deactivate-github-sign-in).

## Current limits

- No canary, batching, general runtime compatibility check, automatic rollback,
  or cluster-wide upgrade lock.
- Runtime upgrades start all recorded Agent deployments concurrently.
- Agent deployments use current drafts rather than recreating active revisions.
- One runtime image is used for both gateway and Agent containers.
- Model, channel, provider, native-access, and restore checks remain manual.

See the [production image upgrade flow](../../flows/coordinated-production-upgrade.md)
for implementation details and failure boundaries.
