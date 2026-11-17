---
rfc: ./index.md
---

# Change download access on a running protected Agent

Let an Installation administrator approve or withdraw a download destination
for one running protected Agent in the Console. The user can retry in the
same shell after the change is confirmed, without restarting the Agent or
losing the conversation.

Protected Agents currently reject ordinary live network edits because those
edits could replace credential rules owned by Sandbox and Credential Proxy.
This amendment adds a live-update contract for that Driver pair. See the
[Agent policy flow](../../../docs/flows/agent-sandbox-policy.md).

## Access and authority

The feature defaults off. Installation settings restrict downloader executables,
destinations and exclusions. An Installation administrator with Agent
`manage_policy` and SandboxPolicy `read` and `update` may approve an eligible
hostname for one Agent. Delegated editors can enable or disable approved
destinations. Withdrawing approval removes dependent grants. OCC audits the
actor and scope and rechecks permissions, current limits, placement, revision
and policy version before dispatch.

A grant permits credential-free HTTPS `GET` and `HEAD` on port 443 to an exact
public hostname. Shared archive hosts require an exact canonical object path.
Each redirect hop requires its own approval. An Installation may explicitly
allow HTTP on port 80 for a signed package mirror, with repository signatures
and package hashes still verified. Reject wildcards, raw IPs, private or metadata
destinations, overlap with managed routes, and rules that would defeat
withdrawal. Recheck DNS peers and request scope. Exclude credential injection,
write methods and general TCP tunnels. Keep signed query values out of policy,
status and audit. Existing [frozen artifact rules](contracts.md#protected-codex-artifact-downloads)
retain their contract.

## Apply and recover

1. OCC atomically saves the desired grant and queues work for the running revision. Before
   dispatch, it records the original operation, confirmed predecessor, immutable
   Sandbox and enforcing instance, provider version and intended policy.
2. Sandbox compiles the complete protected policy, preserving model, Git, plugin
   and credential bindings, and conditionally writes the approved change.
   Credential Proxy independently verifies the provider receipt and the policy
   version and hash loaded by the same supervisor.
3. OCC rechecks authority, revision and predecessor, then atomically publishes
   the confirmed policy and credential installation, including matching Git
   evidence when applicable. Credential authorization requires that installation
   to match the loaded policy through its final check. The Console reports
   **Applied** after commit and shows the last confirmed state while work is
   pending or failed. Saved grants survive restart and are revalidated on deployment.
4. If the provider reply is lost or publication fails, the recovery owner retains
   the original work and receipt, blocks further edits to that Sandbox, and
   reconciles the original provider operation through an authenticated read.
   A later policy version alone cannot settle it. Recovery may retry publication
   after fresh checks and must never repeat an uncertain provider write.
5. Clear recovery state only after publication commits, authorized reconciliation
   verifies the current published installation, or the exact recipient is
   confirmed retired. Fence the old writer and verify a replacement independently.
   Only the recovery owner can read the private data. Preserve it through
   unfinished deletion and remove the work row on final Agent deletion.

A stale edit cannot restore withdrawn access or apply to a replacement.
Confirmed withdrawal denies fresh connections. Previously delivered bytes and
in-progress transfers may survive it.

## Acceptance criteria

Use the existing [Console fixture](../../../tests/browser/console-sandbox-policy-fixture.ts)
and [installed OpenShell workflow](../../../docs/testing/openshell-coverage.md) to verify:

- A denied download succeeds after Console approval and is denied on a fresh
  connection after withdrawal. Verify bytes, timing for both changes, unchanged
  runtime identities, continued model access and isolation from another Agent.
  A combined profile must also preserve authorized Git on the same instance.
- A signed mirror and redirected exact archive work within their approvals.
  Sibling paths, writes, unapproved hops, unauthorized delegation, stale
  revisions and unsupported pairs are refused.
- Requests using the new policy hash before publication or the old hash
  afterward are refused. Racing credential withdrawal remains effective.
- Lost replies, worker restart and failed publication recover with exactly one
  provider write. Further edits stay blocked until settlement. Replacement and
  deletion preserve the required evidence without exposing private recovery data.

[Implementation #5908](https://github.com/openclaw/openclaw-enterprise/pull/5908)
covers a qualified model-only pair and refuses protected Git and credential
reduction. Stock OpenShell 0.1.8 lacks the matched writer and verifier. Installed
qualification is required for each profile before enabling it or claiming latency.
