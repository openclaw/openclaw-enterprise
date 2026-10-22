# Prepare a production handoff

Decide whether a Kubernetes installation is ready for a business workflow
after [deploying and verifying production Agents](production-agents.md#verify-production-workloads).
Record who operates it, access decisions, and evidence in
your organization's private operations record. The deployment guides cover
installation and runtime checks; your organization is responsible for service
commitments, regulatory compliance, and recovery targets for the workload.

## Record the initialization Job for handoff

Before starting, record the trusted cluster, context, namespace and Helm release
in your private operations record. Leave the kubeconfig and credentials out.

For the documented first install (release `oce` in `openclaw-system`), run Helm
once. If no initialization Job existed beforehand and no other install or upgrade
can replace it, read its UID in a second terminal while Helm is running:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  get job oce-initialization -o 'jsonpath={.metadata.uid}{"\n"}'
```

If the Job is not found yet, repeat only the read. Record the UID immediately,
then record the Helm outcome separately (`unknown` if the response was lost).
The UID identifies the Job; it does not mean the installation succeeded.

If you cannot establish those conditions or read the UID, write `Job UID: not
recorded`. Helm can replace an older Job even when the release name is unused;
do not substitute a later UID or rerun the install. The next operator can still
[inspect the current Job](#resume-an-installation-in-progress) without `--expect-job-uid`.

## Resume an installation in progress

Run `occ installation doctor` and `occ installation plan` to inspect the retained
initialization Job. Ask the installer for the Kubernetes context, namespace, Helm
release, and Job UID if recorded. Use the [matching released CLI](../cli.md#occ-cli),
`kubectl`, and your own trusted kubeconfig with permission to get the named Job,
normally `<release>-initialization`. These commands read the Kubernetes API and
do not require an OCC endpoint or service key.

The CLI gets the Job by name. A single `kubectl` invocation resolves the cluster
and credentials together, including when a gateway selects the cluster by URL
path. It may read API discovery metadata and, if the Job is not found, check
whether the Namespace exists. You do not need permission to read the Namespace
or list Jobs or Pods. If the result is inconclusive, initialization is **unknown**.

If a matching CLI release is not yet published, use a trusted checkout of the
matching source with Go installed, and substitute `go run ./cmd/occ` for `occ` in
both commands below. Run them from the checkout root.

```bash
target=(--kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT"
        --kube-namespace "$NAMESPACE" --release "$RELEASE")
# If recorded, use the UID of the Job persisted during the original installation.
if [[ -n ${RECORDED_JOB_UID:-} ]]; then
  target+=(--expect-job-uid "$RECORDED_JOB_UID")
fi
occ installation doctor "${target[@]}"
occ installation plan "${target[@]}"
```

`doctor` reports evidence from the retained Job. `plan` orders the checks for
the person taking over and makes no changes. A command may read the named Job
again if throttled; its result describes the response returned. Compare the
observed UID with the UID recorded from the persisted Job during the original
installation. A dry-run UID or a UID first read after Helm could have replaced
the Job cannot identify that original. If the original UID was not recorded,
omit `--expect-job-uid`: the commands can describe the current Job but cannot tie
it to that earlier attempt. Interpret the result at this target:

- **Completed.** Match the Job UID to the handoff. Helm replaces this Job before
  its next install or upgrade. Exit zero means the returned Job has recognized
  chart fields, no unsupported controller specified, and consistent terminal
  completion evidence. This is consistent with migration and bootstrap
  completing, including verification of an existing Installation. The Job read
  does not attest execution or establish the current database state. A completed
  Job can precede a failed Helm release. Once the original UID matches, ask the
  release operator to verify that release's status and its API and worker
  Deployments' rollout and readiness before using an Agent. Keep the migration
  and bootstrap checkpoint; do not rerun initialization or expand this reader's
  named-Job permission.
- **Recorded Job replaced or missing.** Recover the original installation record.
  A later Job with the same name and a different UID cannot establish what happened
  to that attempt, even if its chart labels have changed.
- **Not found, no UID recorded.** Confirm with the database, identity, and volume owners whether
  this is a first installation. A missing Job is not permission to bootstrap again.
- **Failed.** With a matching Job UID, `plan` shows a Pod lookup for an operator
  who can already list Pods in that namespace; it does not list Pods itself. That
  operator sets `POD_READER_KUBECONFIG` to their own trusted kubeconfig and
  `POD_READER_CONTEXT` to its matching context in their shell, then runs the
  displayed command. Match the Pod's controlling owner UID to the recorded Job UID
  before interpreting the migration and bootstrap exit codes; a label alone is
  insufficient. `<none>` means no current terminated exit code was reported;
  neither `<none>` nor an empty result proves that no Pod ran or no effects occurred.
  The selected columns limit what is printed, not what Kubernetes authorizes or
  returns. If needed, ask for a short, redacted diagnostic, not raw logs or
  credentials. Ask the database and storage owners for current state and output
  provenance; treat unverified state or provenance as unknown. Preserve the attempt
  and do not retry.
- **Unknown or incomplete.** An unreadable Job remains unknown, even if kubectl
  reports a login problem or refusal; it is not evidence that the Job is absent.
  Confirm the target. For a reported login problem, use a separately authorized
  read-only session. For a reported refusal, confirm the intended reader with the
  access owner without restoring temporary privilege or requesting broader access.
  `FailureTarget` alone does not establish terminal failure. An interrupted
  initialization may already have changed state.

The Job UID identifies the initialization, not a later API operation. If an API
attempt had an uncertain outcome, reconcile that original attempt before another
write; do not replay the uncertain operation. Confirm removal of temporary
access with its owner, then use the [workload checks](#verify-the-deployed-workflow)
below.

## Choose the first workflow

Start with one task and a small group. For example, let an Agent read a
support queue and draft replies before enabling customer-facing sends. Name the
business owner, acceptable output quality, response time, cost, and the person
who handles exceptions. Use test records and a private test channel for the
initial checks.

Confirm that the organization can operate the host infrastructure, database,
credentials, and integrations before relying on the workflow.

## Assign operating ownership

Record a primary and backup contact, the exact scope they manage, and how to
reach them when the platform is unavailable. The same person can own several
areas; each responsibility still needs an explicit handoff.

| Area                   | Decision to record                                                                                        | Owning guidance                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Platform               | Who maintains OCC, PostgreSQL, the cluster, storage, images, and deployment inputs.                       | [Production installation](production-installation.md)                                                   |
| Business workflow      | Who approves actions, checks result quality, handles exceptions, and can suspend the work.                | [Agent deployment](production-agents.md)                                                                |
| Access and credentials | Who admits users, grants resource access, renews credentials, and handles compromise or staff departures. | [Authorization](../../reference/authorization.md), [credential lifecycle](credential-lifecycle.md)      |
| Data and evidence      | Which data may leave each workload, where logs and backups live, and their access and retention rules.    | [Runtime security](../../reference/security/runtime-isolation.md), [observability](../observability.md) |
| Usage and cost         | Who owns provider billing, expected request volume, budget alerts, and the response to quota exhaustion.  | [Model credentials](../../reference/agents.md#harness-authentication)                                   |

Kubernetes resource quotas constrain the configured infrastructure resources; they
do not impose a model-spending budget. Use the provider's available spending or
quota controls and document their limits. Include model calls, integrations,
storage, and operator time when measuring the pilot's cost.

## Review access and data destinations

Keep the platform and runtime boundaries distinct. OCC authorizes operations on
its exact resources and manages separate Agent gateways. An OCC role does not
define which CRM records or email recipients a connected business tool may use.
Enforce those limits in the destination system or integration with a dedicated
business identity and narrowly scoped access.

For each integration, record the allowed reads, writes, external destinations,
required reviewer, and revocation owner. Check that the selected runtime can
represent the requested tool policy. A saved plugin selection is desired state,
not proof that its policy is supported or active; see
[Agent plugins](../../reference/agent-plugins.md#lifecycle).

Inventory model endpoints, channel providers, tools, MCP servers, log exporters,
and backup destinations. Include fallback models and secondary processing such
as search or media services. Self-hosting the workload does not establish that
data stays on its host or in one region. The current Kubernetes model-egress
exception allows public TCP/443 beyond a provider-specific allowlist; review
[networking and isolation](../../reference/drivers/kubernetes-compute/networking-and-isolation.md)
before making a destination-isolation claim. Treat retrieved messages, documents,
and web pages as untrusted inputs when deciding which actions may run.

## Verify the deployed workflow

Keep a short evidence record identifying the Namespace, Agent, version,
verification time, expected result, and observed result. Store credential
references rather than values.

1. Complete the [production workload checks](production-agents.md#verify-production-workloads):
   the expected version, denied and allowed gateway access, and a real model
   turn through the selected runtime. A deployment response of `202` means work
   was admitted; `activeRevisionId` alone is not serving-health evidence.
2. Submit a representative business request through the intended channel. Verify
   the source records read, the generated result, and any approved change in the
   destination system. Check the result against the pilot's quality, time, and
   cost expectations.
3. Exercise denied access and, where supported, rejected approvals. Confirm that
   the destination remains unchanged. Demonstrate the human handoff for an
   ambiguous request or unavailable integration.
4. Before enabling retries for writes, test a timeout or repeated request against
   test records. Verify the integration's duplicate-prevention behavior; OCC
   deployment reconciliation does not establish exactly-once CRM updates or
   message delivery.
5. Repeat the relevant checks after a version, credential, plugin, or access
   policy change. Confirm that unrelated Agents retain their intended behavior.

## Connect alerts to a response

Verify each private API/worker metrics target using [Pod discovery](../observability/metrics.md),
and use [platform observability](../observability.md) to connect operational logs
and prove backend receipt. Default local output does not prove remote delivery. Then assign alert thresholds and a response owner for the
workload. Keep an alert route that does not depend on the affected Agent replying.

| Signal                                                          | First operator response                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent remains unready or work stops advancing                   | Check the independent worker, current permissions, runtime readiness, and the selected Driver's diagnostics in [controller troubleshooting](../../reference/controller.md#failures-and-diagnostics). |
| Channel or business action fails despite a reachable gateway    | Verify that integration's credentials, provider quota, and destination result; repeat the affected workflow check.                                                                                   |
| Credential is near expiry or provider quota is exhausted        | Notify the credential or billing owner and use the credential-specific [renewal path](credential-lifecycle.md).                                                                                      |
| Export fails, records are refused, or the Collector queue fills | Check backend receipt, exporter connectivity, and [Collector metrics](../observability.md#check-collector-metrics).                                                                                  |

Operational logs, Collector metrics, PostgreSQL audit records, and destination
transaction records answer different questions. The Collector does not export
the audit ledger or provide application metrics, distributed traces, dashboards,
or business-success alerts. Filtered operational logs are best-effort; their
absence does not prove that an action did not occur. Confirm consequential
business effects in their destination system.

## Prepare recovery and update acceptance

Agree on acceptable downtime and data loss before relying on the workflow.
Controller lease recovery handles interrupted reconciliation; it is not a
backup or a complete Installation restore. There is currently no general OCC
backup/restore command or explicit Agent rollback endpoint.

Record the protection and recovery owner for each required asset:

- External PostgreSQL, including platform state, IAM, work, and audit records.
- Protected Installation YAML, Helm values, image digests, selected Driver
  versions, and required infrastructure configuration.
- Startup, authentication, provider, and runtime Secrets; protected bootstrap
  output; and any private routing certificates and keys.
- Each Agent's private gateway state claim and, for dedicated execution, its
  Harness workspace claim. Review the exact [persistent and ephemeral storage
  boundary](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).
- External Configuration and Secret stores required by the selected Drivers.

Use database- and storage-owner backup procedures that capture consistent state;
do not treat copies of live SQLite files or PVC persistence as a verified backup.
Coordinate the restore points across platform state, runtime state, configuration,
and credentials, and record any consistency limits. Protect backups like the live
data and retain a copy outside the failure domain being recovered.

Have the infrastructure owner review and rehearse the installation-specific
restore procedure on an isolated target. Block production connectivity before
starting a restored API, worker, or runtime: restored work may reconcile or repeat
external actions. Substitute test credentials and disable copied production
channels and scheduled work before allowing test egress. Verify state, access,
and the business workflow; measure recovery time and the age of recovered data.
Before an actual cutover, fence old writers and workloads. RWO storage and normal
version routing do not provide independent process fencing during a node
partition.

For an update, retain the reviewed deployment inputs and a verified recovery
point, rehearse the candidate in a separate environment, and repeat the workload
checks before widening use. Define the failure response with the infrastructure
owner; reverting a Helm release or image does not restore database, Secret, or
workspace state. A saved version fixes the requested configuration and
references. Referenced Secret values and resolved plugin releases can change. See
[version snapshots](../../reference/agents/deployment.md#revisions-and-deployment)
and [plugin lifecycle](../../reference/agent-plugins.md#lifecycle).

## Complete the handoff

The business and platform owners should be able to locate the accepted workflow,
deployed version, access and data decisions, credential renewal dates, alert
responses, and recovery evidence without the original installer. Record unresolved
limits and the decision to accept them or defer the workload. Revisit the handoff
when a new integration, permission, runtime, or data category changes those assumptions.
