---
created: "2026-10-15"
updated: "2026-10-15"
last_updated_session: authoring-run/ea23f0cb-8736-4898-b5fc-92737486fb72
---

# Public GitHub read flow

## Overview

An Installation can let a dedicated Codex Agent inspect a known public GitHub
repository. Compute owns the Agent revision's skill and exact network peer. The separate
reader knows no credentials; GitHub owns visibility at the time of the read.

## Entry Points

- `scripts/render-installation-profile.mjs:buildRendered` pairs Helm and Compute configuration.
- `apps/controller/src/drivers/compute/kubernetes/index.ts:pluginRuntimeSnapshot` prepares the Agent revision.
- A user asks the deployed Agent to read a known public repository.

## Flow

```mermaid
graph TD
  Profile["Operator enables reader"] --> Service["Private Service and reader policy"]
  Profile --> Compute["Freeze eligible reader peer at Agent revision admission"]
  Compute -->|not selected or denied| Ordinary["Agent revision without reader grant or skill"]
  Compute -->|exact reader IP allowed by Agent revision| Revision["Mount managed skill and allow exact peer"]
  Revision --> Proxy["Agent reads through its limited native proxy"]
  Proxy --> Service
  Service --> Github["Anonymous HTTPS GET to api.github.com"]
  Github --> Result["Data within response size limits, opaque 404, or explicit failure"]
  Revision -->|Agent revision stopped or retired| Retire["Remove only its policy and skill snapshot"]
  Revision -->|peer changed and Agent revision reobserved| Narrow["Remove Agent revision policy"]
  Narrow --> Stop["Stop exact Harness and wait for Pods"]
  Stop --> Withdraw["Verify withdrawal and fail preparation"]
```

## Execution Trace

<span id="1-compose-a-private-service-and-an-eligible-revision" class="anchor-alias"></span>

### 1. Compose a private Service and an eligible Agent revision

`packages/occ/src/index.ts` asks the selected Compute Driver for side-effect-free
admission facts before storing the Agent revision. Kubernetes Compute freezes a digest of
the configured reader peer only for a dedicated Codex Agent revision with an explicit
IP allow in its authored proxy. A deny that might match withholds the capability.
`apps/controller/src/drivers/compute/kubernetes/index.ts:publicGithubReadForRevision`
requires the stored fact to match the current peer. An older version without the
fact does not gain reader access, including when its runtime projection is rebuilt. For an eligible Agent revision,
Compute creates the managed skill's parent as the runtime user in both Gateway
and Harness, then projects the same read-only file from the immutable plugin-runtime
snapshot. It also writes an egress policy for that Agent revision to the exact reader Pod
peer and port.

### 2. Resolve the skill and use the actual tool network

`apps/controller/src/drivers/plugin/runtime-translator.ts:codexOpenClawConfiguration`
adds the skill file to native read paths and preserves the authored Service IP allow.
The Gateway discovers its managed copy, and native Codex reads the Harness copy.
The skill asks the Harness to use its proxy even if a shell client normally
bypasses private addresses.

### 3. Recheck public visibility and bound the result

`apps/controller/src/drivers/repo/github/public-read/server.ts:createPublicGithubReadServer`
accepts only approved GET paths. The fixed anonymous provider request carries
neither caller headers nor credentials. Each caller Pod address gets one read in flight,
so one Agent cannot hold every provider slot. Each address also gets at most four of the
reader's 48 connections; a fifth is normally answered 429 with `Retry-After: 1` and closed.
Node checks the 6 s header timeout every second, so idle sockets from one Agent cannot
lock other callers out for more than a few seconds. A GitHub rate limit parks every caller; an
exhausted quota parks until the later of GitHub's retry and reset times. In-flight work and
rate-limit backoff are process-local;
no completed representation, bearer, repository session or durable state is kept.
List links retain the original local path and filters; issue links carry a validated
provider cursor. An unsafe or out-of-range next link reports an incomplete listing.

<span id="4-retire-the-revisions-access" class="anchor-alias"></span>

### 4. Retire the Agent revision's access

`apps/controller/src/drivers/compute/kubernetes/index.ts:deleteRetiredRevisionArtifacts`
removes the Agent revision's reader policy and skill snapshot after its Pods have
terminated. Preparing or activating a successor does not change that grant.
If preparation or activation observes that the operator disabled or changed the
admitted peer, `revokeUnavailablePublicGithubRead` removes the Agent revision policy to
narrow new connections. The immutable reader admission identifies a Compute-owned
Harness even if its pinned Sandbox is now unavailable or has changed. Compute
checks the exact Deployment ownership and ordinary workload profile, then
foreground-deletes it with its UID, waits for the Deployment and its Pods to terminate, and verifies that
the policy and Deployment have not reappeared before failing with a configuration
error. An incomplete observation leaves withdrawal unfinished. Policy deletion
alone does not guarantee existing connections close; an in-flight GET may drain
before Pod termination completes. Reconfiguring the peer
alone does not schedule a reconciliation; the operator can stop the Agent or deploy
an unselected successor and retire the old version. Stop and retirement fence
the admitted Compute-owned Harness before resolving the current Sandbox; an
unavailable or changed Sandbox still leaves ancillary cleanup unfinished and
reports an error. A new Agent revision is needed to select a replacement peer.

When the installation selects protected Credential Proxy, the active revision's own authorized
reconcile or maintenance claim may find that Compute refuses release before preparation.
For a revision with durable unprotected execution admission and this reader grant,
`rejectedExecutionWithdrawal` lets that claim close the same policy and observe the
same workload stopped. An incomplete observation remains pending beyond the convergence
deadline. Completion fails the old release with `EXECUTION_ADMISSION_WITHDRAWN`, even if
the reader peer returned meanwhile. Historical rows admitted before execution admission
existed did not use Credential Proxy, so migration `0060_credential_proxy_admission`
records the unprotected decision on them; the upgrade then closes their access through
this same path instead of leaving them unreadable.

## Debugging and Verification

- Inspect the Agent revision's skill mount, proxy domain and egress policy, then the reader's policy and Service IP.
- Reader readiness checks `/healthz` locally; a successful Agent read must also reach GitHub.
- Ordinary Image Runtime Startup requires stock Codex to read the projected skill and recover a title present only at its TLS provider.
- The gateway-routing integration uses a public pull title absent from its prompt and substitutes only the external provider.

## Related docs

- [Supported public reads, operator setup and retirement](../reference/public-github-reads.md)
- [Managed Agent repository credentials](agent-repository-credentials.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-15 11:05: Project the managed reader skill to Gateway and Harness (authoring-run/ea23f0cb-8736-4898-b5fc-92737486fb72 - 87e12a1169a997a99fec7de261b43a0ea2255f54)

- 2026-10-15 10:35: Use admitted Harness ownership during reader withdrawal (authoring-run/87f54df9-4b7e-43b3-a627-60e6b6678225 - 52b6a608fa3d1ad6a6f9d7170f3dd5c4d624c1a6)

- 2026-10-15 09:55: Stop the selected Harness before withdrawing its reader grant (authoring-run/47f5b717-62d4-4f46-8310-770057b70134 - 97044717385c2af34c6a611e74203f3a2734f4c5)

- 2026-10-15 09:27: Preserve bounded issue pagination cursors (authoring-run/6399ddc9-8441-4407-8b0f-9ee9755a1cc0 - c620c8372898c4720998445f7f7df89b2799336e)

- 2026-10-15 09:03: Freeze reader selection at admission and revoke changed peers (authoring-run/acd06c56-509b-44d8-9dd3-0858ab106ad0 - 07d2178e530c07883a24c17efc950378c52e2b86)
- 2026-10-15 05:37: Bind reader access and retirement to the selected revision (authoring-run/0da590a9-3bb3-4aa3-a005-25ff485692db - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)
- 2026-10-15 05:04: Document public reader revision, proxy and provider boundaries (authoring-run/20c735e1-24ca-4e55-9f8c-8c362173c58a - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)
