# One Off Upgrades

Use this page for release-specific transitions before the
[normal image upgrade](production-upgrade.md). Run an applicable procedure once.
Later upgrades use the normal command. Fresh installations use
[installation setup](production-installation.md).

## Envoy channel egress

Use `scripts/upgrade-channel-egress` to replace the chart-managed Slack proxy
with managed Envoy channel egress. The script uses the existing checked
controller/database/Helm upgrade. It does not run during ordinary image upgrades.

**Source support:** Kubernetes Compute installations with the pre-channel-egress
`slackProxy` Helm settings and matching `runtime.channels.managedProxy` in the
external Installation file. The source chart and controller from before
[PR #6529](https://github.com/openclaw/openclaw-enterprise/pull/6529), parent of
`32662b9d22aed39f782a7058ace80d0f82df44a6`, define this input shape.
External proxies, mixed old/new channel settings, and already-transitioned
installations are refused. Disabled legacy channels remain disabled: obsolete
keys are removed, with no Envoy provisioning or Agent transition.

**Target support:** use this checkout's controller image and stock chart from the
same full Git commit. The shared upgrader checks image/source identity, installed
migration history, candidate startup, and the selected Installation. Do not use
a bare PR-6529 checkout: it rejects old configuration and has no one-off script.
Live qualification and remaining verification are recorded in
[TASK-0054](../../../specs/plans/0054-channel-egress-installation-upgrade.md).

### Prepare the maintenance window

Follow the [upgrade checklist](upgrade-checklist.md) for backups, exclusive
maintenance access, required permissions, and protected files. Retain the actual
installed Helm values and external Installation YAML; do not regenerate them
from an example profile. The helper checks both against the live release.

Review **current saved Agent drafts**. Stop followed by Deploy creates a new
Agent revision from that draft, including unpublished edits. Agent identities,
credentials, and supported workspace state follow ordinary
[Stop and resume](../../reference/agents/deployment.md#stop-and-resume) semantics.
Settle deployments, pending Stops, and Agent deletions under the old controller.
Previously stopped Agents stay stopped. Do not delete Agents for this procedure.

Provide an OCC service key with Installation inventory, Agent read/operate/deploy,
Configuration read, and AgentRevision read access for the affected fleet. Configure
`OCC_URL`, `OCC_SERVICE_KEY_FILE`, and, when required, `OCC_CA_BUNDLE`. Keep
credentials out of command arguments and terminal output. Use the exact
kubeconfig, context, namespace, and Helm release throughout.

Create candidates outside the checkout. List every Pod and Service CIDR and all
node addresses, including public node addresses. Built-in private-address
denials remain in force. The following CIDRs are examples; replace them with
the selected cluster's complete ranges:

```sh
umask 077
scripts/upgrade-channel-egress prepare \
  --namespace "$NAMESPACE" --release "$RELEASE" \
  --values "$INPUT_DIRECTORY/values.yaml" \
  --installation "$INPUT_DIRECTORY/installation.yaml" \
  --excluded-cidr 10.42.0.0/16 --excluded-cidr 10.43.0.0/16 \
  --excluded-cidr 192.0.2.10/32 \
  --out-dir "$INPUT_DIRECTORY/channel-candidate"
```

This command changes no cluster resources. It patches only named channel fields,
asserts that normalized unrelated settings are unchanged, and preserves the
original files. Review the generated files. For an immutable Installation Secret,
prepare an owned replacement using the
[immutable Secret procedure](immutable-installation-upgrade.md), and pass its
name with `prepare --installation-secret NAME`. The normal ownership, unrelated
Secret data, identity, and candidate checks still apply.

### Prepare Envoy before stopping Agents

Follow [Set up managed channel egress](channel-egress.md) with the prepared
candidate values. Complete the dependency check before running the one-off.
Existing dependencies retain their owner; disabled channels skip provisioning.

### Run the transition

Use a controller image built from `SOURCE_REVISION`. Keep runtime images unchanged;
this transition deploys current drafts without retaining historical Harness overrides.
Use the [image-upgrade options](production-upgrade-command.md) for broker selection
when repository credentials require a qualified controller/broker pair.

```sh
scripts/upgrade-channel-egress run \
  --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace "$NAMESPACE" --release "$RELEASE" \
  --values "$INPUT_DIRECTORY/values.yaml" \
  --installation "$INPUT_DIRECTORY/installation.yaml" \
  --candidate-values "$INPUT_DIRECTORY/channel-candidate/values.yaml" \
  --candidate-installation "$INPUT_DIRECTORY/channel-candidate/installation.yaml" \
  --controller-image "$CONTROLLER_IMAGE" --source-revision "$SOURCE_REVISION" \
  --occ "$OCC_BINARY" --evidence-dir "$EVIDENCE_DIRECTORY"
```

Add `--preflight-only` and use a separate fresh evidence directory for a rehearsal.
It creates temporary readiness probes and startup/migration Jobs, then cleans them;
it does not stop Agents or OCC. A successful rehearsal is not execution proof.

Execution records the complete original running-Agent set before the first Stop.
It waits for each asynchronous Stop to clear the active revision under the old
controller. It then checks the expected inventory changes, stops OCC writers,
runs the selected migration mode, updates the Installation and Helm release, and
checks authenticated access to the same Installation. Finally, it deploys the
recorded Agents sequentially and waits for each deployment to succeed.

The protected `channel-agent-operations.json` receipt records original revisions,
Stop responses, deployment IDs, and completed operations. The shared evidence
retains identity, Secret, migration, Helm, and concurrency checks. The ordinary
upgrade command continues to refuse this configuration change.

### Recover and verify

Retain the original evidence and journal; do not restore an older journal from
backup. Use the same command, checkout, inputs and evidence with `--resume` only
after inspecting actual cluster state. Completed operations are not repeated;
the script checks that Agents still select their recorded new revisions.
While both OCC writers are quiesced, it validates the recorded Stop inventory
instead of calling the offline API.
For database mode `separate`, follow the
[database handoff](separate-database-upgrade.md) and resume with
`--migration-history-checked`. For an uncertain Helm outcome, use the existing
[Helm recovery procedure](production-upgrade-recovery.md).

A journal operation marked `sending` has an **unknown outcome**. The script stops
and refuses automatic resubmission. Inspect that Agent's revision history,
deployment status and audit events using the normal CLI/API. For a confirmed
accepted deployment, record its exact deployment ID and change only that target's
`deploy` state to `accepted` in the protected journal. For a confirmed accepted
Stop, change its `stop` state to `accepted`. Set a state back to `unsent` only when
records establish that the request was not accepted. If acceptance cannot be
established, keep the script stopped and recover manually. Never infer failure
from a missing response or missing completion marker.

After completion, verify a model turn, channel delivery, OCC directory lookup,
and allowed/denied egress for the affected Agents. Successful deployment status
alone does not prove a Slack exchange or model execution. Use ordinary image
upgrades for subsequent releases; they do not invoke this procedure again.
