# Prepare a production handoff

Decide whether a Kubernetes installation is ready for a business workflow
after [deploying and verifying production Agents](production-agents.md#verify-production-workloads).
Record who operates it, access decisions, and evidence in
your organization's private operations record. The deployment guides cover
installation and runtime checks; your organization is responsible for service
commitments, regulatory compliance, and recovery targets for the workload.

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

Keep a short evidence record identifying the Namespace, Agent, revision,
verification time, expected result, and observed result. Store credential
references rather than values.

1. Complete the [production workload checks](production-agents.md#verify-production-workloads):
   the expected revision, denied and allowed gateway access, and a real model
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
5. Repeat the relevant checks after a revision, credential, plugin, or access
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
backup/restore command or explicit Agent-revision rollback endpoint.

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
revision routing do not provide independent process fencing during a node
partition.

For an update, retain the reviewed deployment inputs and a verified recovery
point, rehearse the candidate in a separate environment, and repeat the workload
checks before widening use. Define the failure response with the infrastructure
owner; reverting a Helm release or image does not restore database, Secret, or
workspace state. An immutable revision freezes requested configuration and
references, not every referenced Secret value or resolved plugin release. See
[revision snapshots](../../reference/agents/deployment.md#revisions-and-deployment)
and [plugin lifecycle](../../reference/agent-plugins.md#lifecycle).

## Complete the handoff

The business and platform owners should be able to locate the accepted workflow,
deployed revision, access and data decisions, credential renewal dates, alert
responses, and recovery evidence without the original installer. Record unresolved
limits and the decision to accept them or defer the workload. Revisit the handoff
when a new integration, permission, runtime, or data category changes those assumptions.
