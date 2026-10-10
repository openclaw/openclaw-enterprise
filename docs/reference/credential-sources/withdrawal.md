# Credential source withdrawal

Use this reference to revoke a [credential source](../credential-sources.md)
from an Agent's running revision without a redeploy.

## Withdraw a source from an Agent

Withdrawal revokes a source from an Agent's active revision while the revision
keeps running. Send
`POST /namespaces/:namespaceId/agents/:agentId/credential-sources/:credentialSourceId/withdraw`.
The caller needs `agent:operate`, and the active revision must have been
admitted with that source, as its Harness authentication or in
`credentialSources`. The request returns `202` with the withdrawal in state `pending`.
A deployment admitted with the source but not yet active gets its own
withdrawal, so it never attaches the source. A withdrawn Harness source fails
that deployment with `CREDENTIAL_WITHDRAWN`; otherwise it activates without the
source, and the read below then returns its withdrawal. An earlier revision
that still runs because the active revision's deployment has not finished
replacing it gets its own withdrawal too. A replay returns the
same withdrawal and makes the caller its `requestedBy`. It queues another
attempt only if none is queued or running; a queued attempt runs at once.

The worker detaches the source from the revision's Sandbox and records
`revoked` only after the gateway confirms that the revision's placeholders no
longer resolve, even in running processes. Requests already forwarded upstream
are not undone. Read the state with
`GET /namespaces/:namespaceId/agents/:agentId/credential-sources/:credentialSourceId/withdrawal`,
which requires `agent:read`. It returns `requestedBy`, the principal whose
`agent:operate` the worker rechecks, `reason` with `lastAttemptAt` for the
worker's latest attempt, and `withdrawalInProgress`, which is `true` while an
attempt is queued or running. A `pending` withdrawal with reason
`CREDENTIAL_WITHDRAWAL_PENDING` is waiting for the gateway; a Sandbox without a
running process never confirms revocation. `AUTHORIZATION_DENIED` or
`ACTOR_REVOKED` means the requester lost `agent:operate`; another operator can
send the withdraw request again to retry it on their own authority.
`CREDENTIAL_WITHDRAWAL_MISCONFIGURED` or `CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT`
means Compute cannot reach the revision's Sandbox as configured, or found an
object it does not own; the attempt fails without retries, even with
maintenance. Correct the cause, then send the request again.

The worker retries an unconfirmed withdrawal a few times with backoff
(`OCC_WORKER_MAX_ATTEMPTS`; by default about 12 seconds). If those attempts run
out because the gateway is unreachable or has not confirmed revocation (or the
last attempt outlived its worker's claim, after a worker restart or a hung
gateway call), and Compute has no maintenance (the Kubernetes Compute Driver
has none), the worker queues another series 30 seconds later, then after 1, 2
and 4 minutes, then every 5 minutes, 15 series in all (about an hour).
Meanwhile the read shows `pending`, the latest `reason`, and
`withdrawalInProgress: true`, and the source still resolves in the Sandbox. The first series the gateway confirms
records `revoked`, with no replay needed. A withdraw request sent while a
series waits queues nothing more; the series runs at once, on the caller's
authority.

When the last series fails, or every withdrawal left on the revision is denied
to its requester, the withdrawal stays `pending` with
`withdrawalInProgress: false`. Nothing retries it on its own unless the
revision has maintenance (see below). Send the withdraw request again to queue
another attempt, with its own series.

A withdrawn source never re-attaches to that revision. If its Sandbox is
recreated, a withdrawn source is left out and the revision keeps running
without it, unless `harnessAuth` names it. If a Sandbox create that started
before the withdrawal finishes after it, the next deployment or maintenance
pass detaches the source again. A withdrawn Harness source instead fails provisioning with
`CREDENTIAL_WITHDRAWN`, and maintenance of the revision stops preparing it. While any
withdrawal is `pending`, each maintenance pass queues another attempt if none is
outstanding. Maintenance does not recheck grants on withdrawn sources, which never
attach again, so removing one cannot stop it. After model-source withdrawal,
maintenance never prepares the revision again. It continues recovering pending
tool withdrawals even when the model source is already `revoked`, and stops only when every withdrawal is `revoked`.
Redeploy to resume Compute repair.

Withdrawals of different sources on one revision share one worker attempt, but
each is authorized by its own `requestedBy`. A requester who lost
`agent:operate` leaves only their withdrawal `pending` with
`AUTHORIZATION_DENIED`; the others are still revoked.

The revision still references the source, so the source cannot be deleted until
a redeploy replaces the revision. Redeploy the Agent with a replacement source
or another authentication method.

## Related

- [Credential sources](../credential-sources.md)
- [Agent identity and deployment](../agents/deployment.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
