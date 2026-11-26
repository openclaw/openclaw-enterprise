---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# Native Git for Dedicated OpenClaw

TokenService owns Source credentials and Credential Proxy delivers them for each supported Harness. An Agent administrator should be able to use that same flow to deploy a Dedicated OpenClaw Agent with a model Source and approved GitHub repositories. The OpenClaw worker should run stock Git in its Sandbox under the Agent’s Repository grants.

[PR #7224](https://github.com/openclaw/openclaw-enterprise/pull/7224) shipped static Codex PAT enrollment, fresh ServiceAccount PAT issuance into TokenService, and Source-backed Repository grant lifetime. [Credential Design 1.0](https://github.com/openclaw/openclaw-enterprise/pull/7234) records those decisions. This RFC retains its [original submission](https://github.com/openclaw/openclaw-enterprise/blob/1284f025f8f951a4c03a97ba3dd1785ffff96fd5/specs/rfcs/20261124-credential-cutover-pat-and-native-git/dedicated-openclaw-native-git.md) as the history of the placement proposal.

## Current behavior

The OpenClaw Control Plane (OCC) checks the selected Compute Driver when saving a draft with Repository access. Kubernetes Compute already recognizes Dedicated OpenClaw in managed OpenShell service mode, but its stock build has no qualified Gateway image digest for this placement. The OpenClaw worker runs from that image in the Agent Sandbox. At deployment, OCC’s native Repository recipient check independently accepts only Dedicated Codex. Both checks must pass before the Worker can activate the OpenClaw revision.

## Proposed change

Qualify the immutable image and its actual Git and HTTPS helper executables. Record the digest in the existing OpenClaw release selection. Keep the native Kubernetes Compute, OpenShell Sandbox and Credential Proxy checks, then delegate Harness eligibility to Compute at deployment as well as draft save.

OCC uses the existing GitHub App Client and resolves a Namespace Git Source through the same TokenService as the model Source. The revision records the per-Agent [Repository grants](../../../docs/reference/repository-credentials/access-levels.md#native-git-delivery). Credential Proxy attaches the Providers. OpenShell enforces the exact Git recipient, repository, method, path and discovery query. The Git bearer stays outside the Harness and the separate Gateway.
OpenClaw startup uses its own worker executable, scoped Workspace node and worker routes, and qualified image. Compute prepares that Sandbox, verifies native policy and Provider readiness, and releases the Harness through the existing staged workflow. Compute publishes the Agent route after the Harness is ready and the worker has enrolled.

## Interface changes

### API

No changes.

### IAM

No changes.

### Database entities

No changes.

### Driver contract

Use the submitted semantics of `ComputeDriver.validateRepositoryCredentials` for qualified Dedicated OpenClaw. Preserve the existing signature, image check, selected Sandbox and Proxy checks, Workspace route validation, and staged activation. Embedded and operator-workspace placements remain outside this decision.

## Simplifications

Reuse the existing image pin, Source lifecycle and per-Agent Git policy. A second Git delivery path would duplicate enforcement and still require the same image and Workspace qualification.

## Acceptance criteria

1. Through the normal Agent save and deploy APIs with PostgreSQL, select a ready OCC TokenService OpenAI model Source, an eligible GitHub App Client and a Read grant for one repository. A qualified Dedicated OpenClaw placement must reach Worker activation. An unqualified image or recipient must be refused.
2. On the pinned image in a real service-mode Sandbox, verify worker enrollment and a genuine OpenClaw model turn that invokes stock Git through the ordinary exec tool. A read from the selected disposable repository must succeed. An attempted read from an omitted repository must fail with a matching native policy denial. Use a Source capable of reading both repositories so an issuer-side denial cannot stand in for per-Agent enforcement.
3. Tie the model reply, Git results and loaded policy to the same Agent revision and Sandbox. Record the Gateway image digest, actual Git and helper paths, and the scoped node and worker routes. Redact credentials. Claim zero origin traffic only when the origin can independently observe it.
