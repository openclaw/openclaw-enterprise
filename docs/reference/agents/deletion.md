# Agent deletion

A bodyless `DELETE /namespaces/:namespaceId/agents/:agentId` requires exact-Agent
`delete`, sets `status: deleting` and desired state `stopped`, queues teardown,
and returns `202` with `meta.deletionReceiptId`. Keep that receipt to follow the
deletion after the Agent and its access grants are removed. While the Agent exists,
updates, deployment, credential provisioning, and workspace writes return `409`.
Repeated DELETE leaves queued or running work unchanged.

## Follow deletion

Read `GET /namespaces/:namespaceId/agents/:agentId/deletion-status?receiptId=…`
as the same signed-in Principal, with current read permission on that Namespace.
The receipt acknowledges your accepted request, including a repeat of deletion
someone else started. It grants no access to the Agent, audit events or retries.
Losing Agent access does not revoke this receipt; losing Namespace access does.
Without a receipt, a caller with read permission on the Agent can see only deletion
work on that still-existing Agent. A failed read, including `403` or `404`, cannot
establish that deletion finished. After an uncertain DELETE, check status before
deciding whether to send a new request.

Status moves from `queued` to `running` when a worker claims deletion. `waiting`
means a retry is deferred or an expired claim awaits recovery. When provided,
`nextAttemptAt` is the earliest time a worker can retry. The actual start depends
on worker availability. `failed` means automatic attempts stopped and the Agent
remains. Only `deleted` confirms the controller committed deletion. Separate
repository cleanup can still be running.

## Cleanup and retry

The worker reauthorizes the caller, binds the saved identity to
Compute, retires every version, and removes runtime credentials. It
atomically deletes the Agent, its Agent revisions, service principal, API keys, and
exact IAM bindings and restrictions. Kubernetes retirement waits for owned Pods
and removes owned artifacts, including workspace data. Namespace Configurations
and Secrets survive. Deletion releases its name;
[repository cleanup](../repository-credentials.md#repo-driver-contract) continues independently.

Permanent failure or exhausted attempts leave the Agent `deleting`.
After a fix, the initiating caller can repeat DELETE to
reset attempts; OCC and the worker recheck permission. Another
permitted actor gets `403`, audited with the `initiatingActorId`, until the
initiator loses permission, then takes over. Prior failure audits remain and
each retry is audited, as in [Namespace recovery](../namespaces.md#failure-semantics-and-limitations).
