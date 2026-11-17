---
rfc: ./index.md
---

# Change download access on a running protected Agent

An Installation administrator can approve or withdraw a download destination
for one running protected Agent in the Console. The user retries in the same
shell after confirmation, without restarting the Agent or losing the conversation.
The existing [Agent policy flow](../../../docs/flows/agent-sandbox-policy.md)
rejects protected live edits because an ordinary update could replace credential
rules owned by the selected Drivers.

## Contract change

Add a versioned `protectedDownloadPolicy` capability to both selected Drivers.

- `SandboxDriver` provides `prepare`, `apply`, `readReceipt` and `observe`.
  It compiles the full protected policy, conditionally applies the change, and
  recovers the original operation's receipt.
- `CredentialProxyDriver` provides `prepare` and `verify`, plus
  `observeDownloadEnforcement` to read the supervisor's loaded enforcement.
  It independently verifies the receipt, loaded policy hash and credential routes.

A write returns a commit receipt, a proven pre-effect refusal, or an unconfirmed
outcome. OCC publishes the confirmed policy and credential installation together
only when both Drivers agree on the same Sandbox, enforcing instance and policy
version. Include matching Git evidence for a combined profile. Credential requests
must match that installation through final authorization.

## Access and defaults

The editor is available automatically when the Driver pair supports the contract
and verifies the running revision. Initially no destinations are approved.
The pair identifies enforceable downloader executables. Installation policy may
restrict executables and destinations. An Installation administrator with Agent
`manage_policy` and SandboxPolicy `read` and `update` can approve an eligible
hostname for one Agent. Delegated editors can toggle approved destinations.
Withdrawing approval removes dependent grants.

Grant credential-free HTTPS `GET` and `HEAD` on port 443 for an exact public
hostname. Shared hosts require an exact canonical archive path. Approve each
redirect hop separately. An Installation may permit HTTP on port 80 for signed
package mirrors while retaining repository signature and package hash checks.
Deny wildcards, raw IPs, private or metadata destinations, managed-route overlap,
rules that defeat withdrawal, credential injection, writes and general tunnels.
Recheck DNS peers and omit signed query values from policy, status and audit.
Existing [frozen artifact rules](contracts.md#protected-codex-artifact-downloads)
retain their contract.

## Apply and recover

OCC atomically saves the desired grant and work for the active revision.
It audits the actor and scope and rechecks permissions, limits, placement,
revision and predecessor before dispatch. The durable intent binds the original
operation, immutable Sandbox, instance, provider version and intended policy.
Sandbox preserves existing model, Git, plugin and credential bindings.
The Console reports **Applied** only after OCC commits the verified installation.
Saved grants survive restart and are revalidated on deployment.

For a lost reply or failed publication, the recovery owner retains the original
work and any receipt, blocks further edits to that Sandbox, and uses an
authenticated read of the original provider operation. Recovery can retry
publication after fresh checks but cannot repeat an uncertain provider write.
Clear recovery data when publication commits, authorized reconciliation verifies
the current installation, or the exact recipient is confirmed retired. Fence
the old writer and independently verify a replacement. Only the recovery owner
can read private recovery data. Preserve it through unfinished deletion and
remove the work row on final Agent deletion.

Confirmed withdrawal denies fresh connections. Previously delivered bytes and
in-progress transfers can outlast it.

## Acceptance criteria

Use the [Console fixture](../../../tests/browser/console-sandbox-policy-fixture.ts)
and [installed OpenShell workflow](../../../docs/testing/openshell-coverage.md).

- With a qualifying pair and no Installation opt-in, approve a denied download,
  verify bytes, withdraw it and verify fresh denial. Measure both changes.
  Preserve runtime identity, model access, another Agent's isolation and, for
  the combined profile, authorized Git on the same instance.
- Verify signed mirrors and redirected exact archives. Refuse sibling paths,
  writes, unapproved hops, unauthorized delegation and unsupported pairs.
- Refuse mismatched policy hashes and stale revisions. A concurrent credential
  withdrawal remains effective.
- Recover lost replies, restart and failed publication with exactly one provider
  write. Verify edit blocking and recovery-data handling across replacement and deletion.

[Implementation #5908](https://github.com/openclaw/openclaw-enterprise/pull/5908)
currently requires explicit Installation configuration and supports a qualified
model-only pair. Automatic availability and protected Git remain implementation
work. Stock OpenShell 0.1.8 lacks the matched writer and verifier. Qualify the
installed pair for each supported profile.
