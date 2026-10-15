---
created: "2026-10-15"
updated: "2026-10-15"
last_updated_session: authoring-run/acd06c56-509b-44d8-9dd3-0858ab106ad0
---

# Public GitHub read flow

## Overview

An Installation can let a dedicated Codex Agent inspect a known public GitHub
repository. Compute owns the revision's skill and exact network peer. The separate
reader knows no credentials; GitHub owns visibility at the time of the read.

## Entry Points

- `scripts/render-installation-profile.mjs:buildRendered` pairs Helm and Compute configuration.
- `apps/controller/src/drivers/compute/kubernetes/index.ts:pluginRuntimeSnapshot` prepares the revision.
- A user asks the deployed Agent to read a known public repository.

## Flow

```mermaid
graph TD
  Profile["Operator enables reader"] --> Service["Private Service and reader policy"]
  Profile --> Compute["Freeze eligible reader peer at revision admission"]
  Compute -->|not selected or denied| Ordinary["Revision without reader grant or skill"]
  Compute -->|exact reader IP allowed by revision| Revision["Mount managed skill and allow exact peer"]
  Revision --> Proxy["Agent reads through its limited native proxy"]
  Proxy --> Service
  Service --> Github["Anonymous HTTPS GET to api.github.com"]
  Github --> Result["Bounded data, opaque 404, or explicit failure"]
  Revision -->|revision stopped or retired| Retire["Remove only its policy and skill snapshot"]
```

## Execution Trace

### 1. Compose a private Service and an eligible revision

`packages/occ/src/index.ts` asks the selected Compute Driver for side-effect-free
admission facts before storing the revision. Kubernetes Compute freezes a digest of
the configured reader peer only for a dedicated Codex revision with an explicit
IP allow in its authored proxy. A deny that might match withholds the capability.
`apps/controller/src/drivers/compute/kubernetes/index.ts:publicGithubReadForRevision`
requires the stored fact to match the current peer. An older revision without the
fact stays unselected, including when its runtime projection is rebuilt. For a selected revision,
Compute creates the managed skill's parent as the runtime user before projecting
the read-only file. It uses the same immutable plugin-runtime snapshot to write a
revision-owned egress policy to the exact reader Pod peer and port.

### 2. Resolve the skill and use the actual tool network

`apps/controller/src/drivers/plugin/runtime-translator.ts:codexOpenClawConfiguration`
adds the skill file to native read paths and preserves the authored Service IP allow.
The existing workspace node serves managed skill discovery. The skill asks the
Harness to use its proxy even if a shell client normally bypasses private addresses.

### 3. Recheck public visibility and bound the result

`apps/controller/src/drivers/repo/github/public-read/server.ts:createPublicGithubReadServer`
accepts only approved GET paths. The fixed anonymous provider request carries
neither caller headers nor credentials. In-flight work and rate-limit backoff are process-local;
no completed representation, bearer, repository session or durable state is kept.

### 4. Retire the revision's access

`apps/controller/src/drivers/compute/kubernetes/index.ts:deleteRetiredRevisionArtifacts`
removes the revision's reader policy and skill snapshot after its Pods have
terminated. Preparing or activating a successor does not change that grant.
Reconciliation removes the grant earlier if the operator disables or changes the
admitted peer; a new revision is needed to select the new peer.

## Debugging and Verification

- Inspect the revision's skill mount, proxy domain and egress policy, then the reader's policy and Service IP.
- Reader readiness checks `/healthz` locally; a successful Agent read must also reach GitHub.
- Ordinary Image Runtime Startup requires stock Codex to read the projected skill and recover a title present only at its TLS provider.
- The gateway-routing integration uses a public pull title absent from its prompt and substitutes only the external provider.

## Related docs

- [Supported public reads, operator setup and retirement](../reference/public-github-reads.md)
- [Managed Agent repository credentials](agent-repository-credentials.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-15 09:03: Freeze reader selection at admission and revoke changed peers (authoring-run/acd06c56-509b-44d8-9dd3-0858ab106ad0 - 07d2178e530c07883a24c17efc950378c52e2b86)
- 2026-10-15 05:37: Bind reader access and retirement to the selected revision (authoring-run/0da590a9-3bb3-4aa3-a005-25ff485692db - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)
- 2026-10-15 05:04: Document public reader revision, proxy and provider boundaries (authoring-run/20c735e1-24ca-4e55-9f8c-8c362173c58a - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)
