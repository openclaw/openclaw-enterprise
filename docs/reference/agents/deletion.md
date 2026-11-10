# Agent deletion

A bodyless `DELETE /namespaces/:namespaceId/agents/:agentId` requires exact-Agent
`delete`, sets `status: deleting` and desired state `stopped`, queues teardown,
and returns `202` with the deleting Agent. While the Agent exists, updates,
deployment, credential provisioning, and workspace writes return `409`.
Repeated DELETE leaves queued or running work unchanged.

## Follow deletion

Read `GET /namespaces/:namespaceId/agents/:agentId/deletion-status`. Status follows
the Agent; completion follows the verified finalizing actor:

- While the Agent exists, the read needs current read permission on that Agent.
- After deletion commits, `deleted` is returned to a caller with Agent read across
  the Namespace, or to the actor whose delete permission the worker rechecked when
  it finalized the deletion, while that actor can still read the Namespace.

Every other caller gets the same `403` whether the Agent exists, was deleted or
never existed. Removing someone's Agent access ends what they can learn about it.
A `403` or `404` never establishes that deletion finished. After an uncertain
DELETE, check status before deciding whether to send a new request.

Status moves from `queued` to `running` when a worker claims deletion. `waiting`
means a retry is deferred or an expired claim awaits recovery. When provided,
`nextAttemptAt` is the earliest time a worker can retry. The actual start depends
on worker availability. `failed` means automatic attempts stopped and the Agent
remains. Only `deleted` confirms the controller committed deletion. Separate
repository cleanup can still be running.

## Cleanup and retry

The worker reauthorizes the caller, binds the saved identity to
Compute, retires every version, and removes runtime credentials. It rechecks
the caller's delete permission in the finalizing transaction, then
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
