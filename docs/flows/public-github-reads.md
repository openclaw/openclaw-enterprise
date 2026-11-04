---
created: "2026-10-15"
updated: "2026-11-03"
last_updated_session: authoring-run/7e419797-9505-47d1-836b-b0af838ed449
---

# Public GitHub read flow

## Overview

A dedicated Codex Agent can clone and fetch public repositories with ordinary
GitHub HTTPS URLs alongside its protected repository bindings. The Installation
ceiling intersects the Agent revision's selected public-read policy. Compute
publishes revision authorization to a private reader, which sends anonymous
requests to fixed GitHub origins. This flow ends at the Git/API response or
completed authorization withdrawal; installed-runtime qualification is separate.

## Entry Points

- `scripts/render-installation-profile.mjs:buildRendered` pairs Helm and Compute inputs.
- `packages/occ/src/index.ts` freezes selected Compute services during authorized Agent deployment.
- `apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision` prepares the selected runtime and reader authorization.

## Flow

```mermaid
graph TD
  Selection["Installation ceiling<br/>Agent selection"] --> Admission["OCC freezes service<br/>Sandbox acknowledges"]
  Admission -->|unselected| Deny["No reader capability"]
  Admission --> Lease["Compute publishes verifier<br/>Reader observes projection"]
  Lease --> Runtime["Project public files<br/>Deliver private capability"]
  Runtime --> Git["Ordinary GitHub URL"]
  Git -->|bound repository| Protected["Original authenticated Git"]
  Git -->|public candidate| Reader["Reader authenticates revision<br/>Checks both scopes"]
  Reader -->|denied| Failure["No provider request"]
  Reader -->|allowed and public| Github["Anonymous GitHub request<br/>Stream result within limits"]
  Lease -->|authorized maintenance| Lease
  Lease -->|stop or retirement| Withdraw["Expire authorization<br/>Stop owning runtime"]
  Withdraw --> Ack["Observe revision digest<br/>Or leave cleanup pending"]
```

## Execution Trace

<span id="1-compose-a-private-service-and-an-eligible-revision" class="anchor-alias"></span>

### 1. Compose a private Service and an eligible Agent revision

`apps/controller/src/drivers/compute/kubernetes/index.ts:admitServiceAccess` reads the original Driver-owned
Configuration before Sandbox normalization.
`packages/occ/src/index.ts:checkedComputeServiceAccess` supplies the authoritative
runtime Installation ID alongside Configuration and Harness; Compute freezes it
in the descriptor. The profile renderer keeps the operator ID only in Helm
values for registry ownership, never in startup YAML. The recursive startup
guard continues to reject reserved identity keys. Omitted or empty selection grants
nothing; a covering authored deny also withholds the service. OCC saves the
nonsecret descriptor under `AgentRevision.compute.serviceAccess`. A selected
Sandbox must acknowledge the exact descriptor in `SandboxPolicySnapshot`.
Protected execution uses `admitProtectedNetworkPolicy`; both paired OpenShell
compilers consume the frozen facts, rather than importing new Installation rules.

`publicGithubReadService` requires a valid frozen Installation identity and checks
the endpoint, peer, registry and public CA against current configuration. The
authorization store checks its owner label and rows against the frozen identity.
The `public-github-read:v2`
admission digest selects a distinct launcher; rebuilding an older revision does
not implicitly enable it. Existing `v1` ordinary API-reader revisions retain
their earlier admission and ownership checks.

The chart mounts operator-created TLS and authorization resources into a
reader without a service-account token. Helm owns public policy and trust files;
it never renders mutable authorization data. Compute needs network reachability
to the reader's verified HTTPS Service for readiness and withdrawal observation.

### 2. Publish authorization and project runtime material

`apps/controller/src/drivers/compute/kubernetes/public-github-read-authorizations.ts`
creates or verifies an immutable revision Secret containing a random capability.
It updates the verifier-only registry with Kubernetes `resourceVersion` checks.
The row identifies the Installation, Namespace, Agent, revision and frozen scope,
with a ten-minute lease. Preparation and activation wait for the reader's
`/healthz?revision=...` digest to match the projected row. Unrelated Agent renewals
do not change this acknowledgement.

`apps/controller/src/drivers/compute/plugin-runtime.ts:pluginRuntimeConfigMapData`
projects only endpoint, public CA, authenticated repository names and the managed
skill. An ordinary Harness mounts its capability Secret. OpenShell delivers the
capability through its existing endpointless runtime provider; the workload sees
an identity-bound placeholder. Only the selected reader endpoint binds that
provider. The supervisor needs the reader CA in its own native TLS trust store. Stock
Kubernetes OpenShell needs a qualified trust-image layer or operator admission
injection for a private issuer; Harness trust alone does not configure it.
Compute's NetworkPolicy grants reader egress to the selected ordinary Harness or
the exact trusted supervisor peer; a protected workload receives no direct grant.

### 3. Route ordinary Git URLs and enforce public scope

`apps/controller/src/drivers/repo/github/public-read/transport.mjs` installs a
private `git-remote-https` helper from the new launcher. It preserves stored
remotes and the image's other Git helpers. Exact authenticated repository names
retain the original URL, helper and credentials. Other canonical GitHub HTTPS
repositories use the reader's `/git/OWNER/REPOSITORY.git` route. A reader denial
never falls back to GitHub.

For public requests, the child clears inherited command-line Git configuration
and applies settings for the exact rewritten URL. It resets headers, cookies,
credential helpers and Git-configured proxies; verifies TLS with combined reader
and inherited trust; disables redirects and interactive credentials; and preserves
the environment proxy route used by OpenShell. An inherited client TLS identity
causes refusal before contact. Configuration and public material files contain
no capability value.

`apps/controller/src/drivers/repo/github/public-read/server.ts:createPublicGithubReadServer`
authenticates before quota admission, deduplication or provider requests. API and
Git reads apply the current ceiling and revision scope. The reader checks current
public visibility and uses only fixed `api.github.com` and `github.com` HTTPS
origins, without caller credentials, cookies or redirects. `git.ts` permits only
Git upload-pack discovery and requests. It streams with backpressure and cancels
upstream work on failure or disconnect; size and deadline limits fail explicitly.
Quota and in-flight state remain process-local. Address-based limits do not prove
per-Agent fairness when Agents share a supervisor address.

<span id="4-retire-the-revisions-access" class="anchor-alias"></span>

### 4. Maintain or withdraw the revision's access

Kubernetes Compute renews only the frozen policy. After repository Git expires,
`apps/controller/src/worker.ts:withdrawExpiredRepositoryAccess` verifies independent IAM, model, Secret/admission
and Backend obligations before calling `ComputeDriver.maintainServiceAccess`
under the claim heartbeat. This does not prepare or activate a runtime or issue
another Git session. Loss of independent authority prevents renewal.

`beginPublicGithubReadWithdrawal` expires authorization before runtime shutdown,
then observes the reader's revision digest. A registry write or reader failure
cannot prevent the shutdown attempt; cleanup reports failure and retries rather
than claiming withdrawal complete. User stop can suspend and later resume the
same immutable capability. Retirement and an observed peer change permanently
withdraw the saved authorization; it cannot be restored by preparing that revision.
An expired or unreadable row denies future reads even if maintenance is unavailable.

For legacy `v1` reader revisions, `revokeUnavailablePublicGithubRead` removes the
revision policy, foreground-deletes the owned Compute Deployment and waits for
its Pods before reporting withdrawal. Policy deletion alone does not close
existing connections. The owning active claim's `rejectedExecutionWithdrawal`
also fences those revisions when an Installation switches to protected execution.
Current Sandbox failure can leave ancillary cleanup pending; it is not evidence
that the owning runtime has stopped.

## Debugging and Verification

- Compare the saved service descriptor, reader policy, public trust and exact peer before checking runtime files. Never print capability Secrets or provider values.
- `/healthz` proves readable input; the revision digest proves the mounted authorization row. Neither proves GitHub reachability or a successful Agent clone.
- Controlled native Git/TLS tests prove clone, fetch, scope denial, withdrawal and transport isolation. Kubernetes store tests prove Secret ownership, restart and permanent withdrawal.
- PostgreSQL worker tests prove independent maintenance after Git expiry and refusal after IAM loss. Installed Podman/k3d/OpenShell Agent proof remains required before deployment qualification.

## Related docs

- [Supported public reads, operator setup and retirement](../reference/public-github-reads.md)
- [Managed Agent repository credentials](agent-repository-credentials.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-03 23:48: Pass runtime Installation identity through generic admission context; omit it from startup YAML (accompanying correction; authoring-run/7e419797-9505-47d1-836b-b0af838ed449 - f6928cf0ee5cfec351f78dedcba02f0c1a9ecfa2)

- 2026-11-03 18:09: Describe scoped API and Git reads, transport isolation, leased authorization and withdrawal (accompanying implementation; authoring-run/36a8f335-4206-49ad-bc39-1ec044ec81d9 - 83a17289139a58b8adcb605e8b484c47b257dcdb)

- 2026-10-15 11:05: Project the managed reader skill to Gateway and Harness (authoring-run/ea23f0cb-8736-4898-b5fc-92737486fb72 - 87e12a1169a997a99fec7de261b43a0ea2255f54)

- 2026-10-15 10:35: Use admitted Harness ownership during reader withdrawal (authoring-run/87f54df9-4b7e-43b3-a627-60e6b6678225 - 52b6a608fa3d1ad6a6f9d7170f3dd5c4d624c1a6)

- 2026-10-15 09:55: Stop the selected Harness before withdrawing its reader grant (authoring-run/47f5b717-62d4-4f46-8310-770057b70134 - 97044717385c2af34c6a611e74203f3a2734f4c5)

- 2026-10-15 09:27: Preserve bounded issue pagination cursors (authoring-run/6399ddc9-8441-4407-8b0f-9ee9755a1cc0 - c620c8372898c4720998445f7f7df89b2799336e)

- 2026-10-15 09:03: Freeze reader selection at admission and revoke changed peers (authoring-run/acd06c56-509b-44d8-9dd3-0858ab106ad0 - 07d2178e530c07883a24c17efc950378c52e2b86)
- 2026-10-15 05:37: Bind reader access and retirement to the selected revision (authoring-run/0da590a9-3bb3-4aa3-a005-25ff485692db - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)
- 2026-10-15 05:04: Document public reader revision, proxy and provider boundaries (authoring-run/20c735e1-24ca-4e55-9f8c-8c362173c58a - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)
