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

For enabled legacy channels with running Agents, check guarded Stop.
`--preflight-only` skips Stop. In a trusted checkout, select `OCC_BINARY`.
Set `INCUMBENT_SOURCE_REVISION` from the installed controller image’s verified
source commit. Reserve `SOURCE_REVISION` for the target.

```bash
(
  set -o pipefail
  [[ ${INCUMBENT_SOURCE_REVISION:-} =~ ^[0-9a-f]{40}$ ]] &&
    GIT_ALLOW_PROTOCOL= GIT_NO_LAZY_FETCH=1 git --no-replace-objects cat-file blob \
      "${INCUMBENT_SOURCE_REVISION}^{commit}:packages/contracts/openapi/occ-api.openapi.json" |
    jq -e '.paths["/namespaces/{namespaceId}/agents/{agentId}/stop"].post |
      .operationId == "stopAgent" and
      any(.parameters[]?; .in == "query" and .name == "expectedActiveRevisionId")' >/dev/null &&
    "${OCC_BINARY:?Select the operator CLI}" agent stop --help |
    grep -E '^[[:space:]]+--if-active-revision[[:space:]]' >/dev/null &&
    printf '%s\n' 'Guarded Stop source and CLI checks passed.'
) || { printf '%s\n' 'Hold the upgrade. Verify the installed controller and operator CLI.' >&2; false; }
```

Hold if provenance is missing or either check fails. Declared support cannot
prove live enforcement. Older APIs can return HTTP 400 after the journal
records `sending`. [Reconcile uncertain Stops](#recover-and-verify).

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

Set `KUBECONFIG_FILE`, `CONTEXT`, `NAMESPACE`, and `RELEASE` for the selected
release. Set `HELM_REVISION` to its installed revision as a positive decimal
integer without leading zeros. Set `INPUT_DIRECTORY` to an existing private
directory you control. Use a trusted operator environment and private kubeconfig.
Keep the Helm overrides checked below unset throughout the upgrade.

Before capture, confirm that the user selected by `CONTEXT` meets the
[production upgrade credential policy](production-upgrade-command.md#run-the-image-upgrade).
Use a token or client certificate when kubectl preferences are enabled. If the
selected user uses an exec credential plugin while preferences are enabled, stop
and follow your approved upgrade procedure. Built-in `auth-provider` entries
are unsupported.

Run capture, preparation, and execution in the same Bash shell. A successful
capture sets `ATTEMPT_DIRECTORY` to a new private directory for the captured
values and the candidate. If capture fails, resolve the error before continuing.

```bash
ATTEMPT_DIRECTORY=$(
  { set +x; } >&2
  : "${INPUT_DIRECTORY:?}" "${KUBECONFIG_FILE:?}" "${CONTEXT:?}" "${NAMESPACE:?}" "${RELEASE:?}" "${HELM_REVISION:?}"
  case "$HELM_REVISION" in
    0*|*[!0123456789]*)
      printf '%s\n' 'Set HELM_REVISION to a positive decimal integer without leading zeros.' >&2
      exit 1
      ;;
  esac
  if [[ "${HELM_DRIVER:-secret}" != secret ]]; then
    printf '%s\n' 'Unset HELM_DRIVER or set it to secret to read Helm release Secrets.' >&2
    exit 1
  fi
  for variable in \
    HELM_KUBEAPISERVER HELM_KUBECAFILE HELM_KUBETLS_SERVER_NAME HELM_KUBEINSECURE_SKIP_TLS_VERIFY \
    HELM_KUBETOKEN HELM_KUBEASUSER HELM_KUBEASGROUPS; do
    if [[ -n "${!variable:-}" ]]; then
      printf 'Unset %s and use the settings in the selected kubeconfig.\n' "$variable" >&2
      exit 1
    fi
  done
  umask 077 &&
    ATTEMPT_DIRECTORY=$(mktemp -d "$INPUT_DIRECTORY/channel-upgrade.XXXXXXXX") &&
    helm get values \
      --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
      --namespace "$NAMESPACE" --revision "$HELM_REVISION" --output yaml -- "$RELEASE" \
      > "$ATTEMPT_DIRECTORY/values.yaml" &&
    printf '%s\n' "$ATTEMPT_DIRECTORY"
)
```

If the first line of a Helm display capture is `USER-SUPPLIED VALUES:` or
`COMPUTED VALUES:` with optional trailing whitespace, the helper checks that
entry as YAML. It gives recapture guidance for an implicit null at that entry
or a YAML parse failure during the check. If the helper asks you to recapture
before execution has submitted work, keep the earlier attempt private. Repeat
the capture with the same selectors and prepare a candidate in the new attempt
directory. If `run` may already have submitted work, stop and reconcile the
recorded operations using [Recover and verify](#recover-and-verify).

A genuine first entry written in the same bare form with an implicit null is
indistinguishable from a display heading. Use an explicit `null` for that value
in a values file you author.

Create candidates outside the checkout. List every Pod and Service CIDR and all
node addresses, including public node addresses. Built-in private-address
denials remain in force. The following CIDRs are examples; replace them with
the selected cluster's complete ranges:

```bash
umask 077
scripts/upgrade-channel-egress prepare \
  --namespace "${NAMESPACE:?}" --release "${RELEASE:?}" \
  --values "${ATTEMPT_DIRECTORY:?}/values.yaml" \
  --installation "${INPUT_DIRECTORY:?}/installation.yaml" \
  --excluded-cidr 10.42.0.0/16 --excluded-cidr 10.43.0.0/16 \
  --excluded-cidr 192.0.2.10/32 \
  --out-dir "$ATTEMPT_DIRECTORY/candidate"
```

This command changes no cluster resources. It patches only named channel fields,
asserts that normalized unrelated settings are unchanged, and preserves the
original files. Review `$ATTEMPT_DIRECTORY/candidate/values.yaml` and
`$ATTEMPT_DIRECTORY/candidate/installation.yaml` in a private editor.
For an immutable Installation Secret,
prepare an owned replacement using the
[immutable Secret procedure](immutable-installation-upgrade.md), and pass its
name with `prepare --installation-secret NAME`. The normal ownership, unrelated
Secret data, identity, and candidate checks still apply.

### Prepare Envoy before stopping Agents

Follow [Set up managed channel egress](channel-egress.md) with the prepared
values at `$ATTEMPT_DIRECTORY/candidate/values.yaml`. Complete the dependency
check before running the one-off. Existing dependencies retain their owner.
Disabled channels skip provisioning.

If ingress to the Envoy controller is restricted, ask its owner to allow the
permanent channel fleet and the named probe as described in the setup guide.
Add `--channel-probe-name "$PROBE_NAME"` to the `run` command below for
preflight, deployment, and resume. Keep the probe rule until the last check
and its cleanup finish. Resume from the original release checkout with the
same probe name and unchanged helper.

### Run the transition

Use a controller image built from `SOURCE_REVISION`. Keep runtime images unchanged;
this transition deploys current drafts without retaining historical Harness overrides.
Use the [image-upgrade options](production-upgrade-command.md) for broker selection
when repository credentials require a qualified controller/broker pair.

```bash
scripts/upgrade-channel-egress run \
  --kubeconfig "${KUBECONFIG_FILE:?}" --context "${CONTEXT:?}" \
  --namespace "${NAMESPACE:?}" --release "${RELEASE:?}" \
  --values "${ATTEMPT_DIRECTORY:?}/values.yaml" \
  --installation "${INPUT_DIRECTORY:?}/installation.yaml" \
  --candidate-values "$ATTEMPT_DIRECTORY/candidate/values.yaml" \
  --candidate-installation "$ATTEMPT_DIRECTORY/candidate/installation.yaml" \
  --controller-image "${CONTROLLER_IMAGE:?}" --source-revision "${SOURCE_REVISION:?}" \
  --occ "${OCC_BINARY:?}" --evidence-dir "${EVIDENCE_DIRECTORY:?}"
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

Keep the original evidence, journal, and attempt paths while the outcome is
unresolved. `$EVIDENCE_DIRECTORY/before-values.yaml` holds the original captured
Helm values. Do not restore an older journal from backup. Use the same command,
checkout, inputs, and evidence with `--resume` only after inspecting actual
cluster state. Completed operations are not repeated. The script checks that
Agents still select their recorded new revisions.
While both OCC writers are quiesced, it validates the recorded Stop inventory
instead of calling the offline API.
For database mode `separate`, repeat the same one-off `run` command with
`--migration-apply-only` after exit 3, without `--resume`. It applies and verifies
the original Installation's database through the shared guarded Jobs. Then repeat
the original command with `--resume --migration-history-checked`. Follow the
[database handoff](separate-database-upgrade.md) for Secret identity, quiescence
and unresolved-Job requirements. For an uncertain Helm outcome, use the existing
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
alone does not prove a Slack exchange or model execution.

After verification succeeds, stage the updated `--values` file at
`$ATTEMPT_DIRECTORY/values.yaml` and `$INPUT_DIRECTORY/installation.yaml` as a
matched pair in the protected `installationDirectory` of your
[normal image upgrade profile](production-upgrade-command.md). Use that profile
for subsequent upgrades.
