---
rfc: ./index.md
---

# Change download access for a running protected Agent

An Installation administrator can approve or withdraw a download destination
for one running protected Agent in the Console. Once OCC confirms the change,
the user can retry in the same shell. The edit leaves the Agent revision,
Sandbox and conversation running. Today protected Agents refuse these live
edits because ordinary policy updates can replace rules the protected Drivers
own. See the [Agent policy flow](../../../docs/flows/agent-sandbox-policy.md).

## Authority and scope

Protected download editing defaults off. The Installation chooses eligible
download executables, destinations and exclusions. Within those limits an
administrator with Agent `manage_policy` and SandboxPolicy `read` and `update`
can approve a previously unseen eligible hostname for one Agent. A delegated editor can
enable or disable access within existing approval. Only an administrator can
expand that approval. Withdrawing approval removes the grants that depend on it.
OCC records the actor and scope in its existing audit and rechecks authority,
limits, placement, the running revision and the expected policy version before
the worker writes to the provider.

| Destination           | Allowed access                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public hostname       | Credential-free HTTPS `GET` and `HEAD` on port 443 by eligible executables.                                                                                  |
| Shared archive host   | The exact approved canonical path. Each redirect hop needs its own allowed scheme, host, port and path.                                                      |
| Signed package mirror | Plain HTTP on port 80 only when the Installation explicitly permits that mirror. The package manager verifies signed repository metadata and package hashes. |

The pair denies wildcard hosts, raw IPs, private or metadata destinations,
overlap with managed routes, and access another rule would keep open after
withdrawal. It rechecks resolved peers and request scope. The contract excludes
credential injection, write methods and general TCP tunnels. Keep signed URL
query values out of saved policy, status and audit. The
[frozen artifact rules](contracts.md#protected-codex-artifact-downloads) and
ordinary unprotected editing keep their existing contracts.

## Provider write and confirmation

OCC queues one operation for the running revision. The Sandbox Driver compiles
the complete policy from the confirmed predecessor and changes only the
approved download rules. A conditional write binds the original operation,
immutable Sandbox, enforcing instance, provider version and intended policy.
Before dispatch, OCC saves that intent and predecessor on the original work
record. A pair that cannot verify the baseline or preserve the protected routes
refuses the edit.

Credential Proxy verifies the provider receipt and the policy version and hash
loaded by the same supervisor. It confirms that existing model, Git and plugin
rules, bindings and recipients are preserved. OCC then rechecks the current
authority, revision and predecessor. It publishes the confirmed policy and
credential installation together, including matching Git evidence where Git is
admitted. Credential checks require the verified loaded policy to match the
published installation through final authorization. A stale edit cannot overwrite
a credential withdrawal or apply to a replacement. The Console shows **Applied**
only after publication commits and keeps the last confirmed state visible during
pending or failed work. Saved grants survive restart and are revalidated on deployment.

## Recover an uncertain outcome

If the write response is lost, the recovery owner reads the original provider
operation and verifies the loaded policy. A later version alone is insufficient.
Keep the original intent and any late receipt through restart, failure and
replacement. Block further edits to that Sandbox while the outcome is uncertain
or verified but unpublished. Retry publication after rechecking authority and
the predecessor. Recovery uses the single original provider write.

Settle the retained record when publication commits, authorized reconciliation
verifies the current published policy, or the exact recipient is confirmed
retired. Fence the old writer before admitting an edit for a replacement.
Verify the replacement independently. Old receipts cannot confirm the new
revision. Only the recovery owner can read private recovery data. Preserve it
through an unfinished deletion and remove the work record on final Agent
deletion.

Confirmed withdrawal denies fresh connections to the removed scope. Bytes
already delivered and transfers in progress can outlast the change.

## Acceptance criteria

Use the [Console fixture](../../../tests/browser/console-sandbox-policy-fixture.ts)
and [installed OpenShell workflow](../../../docs/testing/openshell-coverage.md)
against a matched Sandbox and Credential Proxy pair.

1. Deny an unapproved download, approve it from the Console, verify the bytes,
   then withdraw it and verify a fresh denial. Record grant and withdrawal
   latency separately. Keep Agent, revision, Sandbox, Pod and supervisor
   identities fixed. Verify continuing model use and another Agent's denial.
   For the combined profile, verify authorized Git on the same instance after
   both grant and withdrawal.
2. Exercise a signed package mirror and an exact archive after a redirect.
   Refuse a sibling archive, write method, unapproved hop, unauthorized
   delegation, stale revision and unsupported pair.
3. Verify new-hash requests before publication and stale-hash requests after it
   fail. Race an edit with credential withdrawal and preserve the withdrawal.
   Verify retention and privacy across replacement and deletion.
4. Lose a provider reply and restart the worker. Fail the first publication
   after the original receipt arrives. Keep new edits blocked until the
   original write is settled, and verify exactly one provider write.

[Implementation PR #5908](https://github.com/openclaw/openclaw-enterprise/pull/5908)
supports live editing for a qualified model-only pair. Its current scope
refuses protected Git and credential-reduction profiles. Stock OpenShell 0.1.8
lacks the required matched writer and verifier. Qualify each installed profile before
enabling it or claiming access and latency results.
