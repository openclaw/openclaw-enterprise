---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: Limit Codex scheduled tools

- **ID:** RFC-20261123-dedicated-codex-automation-tool-cap
- **Created:** 2026-11-23
- **Last updated:** 2026-11-23
- **RFC PR:** [#6942](https://github.com/openclaw/openclaw-enterprise/pull/6942)
- **Predecessor:** [Agent automations](20261121-agent-automations.md)
- **Implementation plan:** [Broker implementation](../plans/20261121-agent-automations.md)

## Decision

Extend the Compute Driver's automation qualification for ordinary dedicated Codex Agents. Require
the operator to supply both `tools.codeMode: false` and the explicit automation policy below in the
raw Agent revision and require `revision.harnessAuth.method === "api_key"` before any automation
grant, including a model-only grant with `toolsAllow: []`. Compute must constrain native Code Mode
and sleep features through the dedicated Agent's managed requirements. Approved static MCP tools
must remain available through their direct dynamic-tool declarations.

## Problem

The accepted automation RFC requires a finite native tool cap. A genuine scheduled Codex turn still
used the native JavaScript `exec` tool to call its approved MCP tool despite that cap. The checked
forbidden service, file, and network effects were absent; the observation does not prove broader
unauthorized access. The packaged Codex CLI also enables `sleep_tool` by default. Neither capability
belongs in the approved finite cap or an empty cap.

## Proposal

An ordinary deployment-backed dedicated Codex revision qualifies only with immutable
`revision.harnessAuth.method === "api_key"`. Refuse runtime, PAT, ChatGPT/OAuth, and every
`credential_source` mode; the public credential source does not prove its private login mode. The
serving wrapper must enforce native API-key login, reject access tokens and ChatGPT account
metadata, and remove credential, token, and account environment entries before serving. Its
`CODEX_HOME` auth and configuration state is revision-local. This scope has no authenticated cloud
Agent Security requirements source.

Every dedicated grant, including `toolsAllow: []`, also requires
`revision.repositoryCredentials === undefined` and
`revision.sandboxPolicy?.repositoryNetworkPolicy === undefined`. Preserve the ordinary unprotected
posture: `executionAdmission.mode === "unprotected"` and no `sandboxDriverId`, `egressPlan`, or
`credentialDeployment`. This excludes protected native Git, including
`egressPlan.repositoryGitAuthorization === "network-policy"`. Repository credentials and protected
Git add another Agent authority and can change the launcher or revision configuration asset; the
ordinary requirements verifier cannot qualify that variant. Use a separate ordinary Agent without
repository authority. Supporting repository-enabled Agents needs separate qualification.

The raw `revision.configuration` must also contain both:

```json
{
  "tools": {
    "codeMode": false,
    "gatewayPolicy": {
      "automations": { "scope": "caller", "allowCommandJobs": false }
    }
  }
}
```

Do not infer this opt-in from rendered Gateway configuration: the renderer also supplies that
automation policy when the raw revision omits it. For an opted-in revision, Compute must render a
revision-owned Codex
[managed requirements](https://learn.chatgpt.com/docs/enterprise/managed-configuration) file with
these feature constraints:

```toml
[features]
code_mode_host = false
code_mode = false
code_mode_only = false
sleep_tool = false
```

Add one nonsecret `requirements.toml` key to the existing immutable revision-scoped plugin-runtime
ConfigMap. Project that key only into the dedicated Agent volume and mount it read-only by `subPath`
at `/etc/codex/requirements.toml`. The Gateway must not project or mount the key. Select the content
and mount from the raw immutable revision and deployment type, independently of current endpoint
attestation, automation eligibility, or retained grants. Withdrawing an attestation must not remove
the constraints for a standing job. Codex reads the same requirements on every native process spawn
and restart.

CLI `--disable` flags set defaults that a thread can override. Managed requirements constrain the
feature values even when a thread requests a conflicting setting. The Agent-local readiness probe
must call native `configRequirements/read` and fail readiness unless all four effective feature
requirements are exactly `false`. At admission, Compute must verify that the exact Agent Pod is
currently Ready and that its probe, requirements mount, container, image, and source provenance
match the selected revision. Refuse admission for an unready or unverifiable Pod. This requires no
new cross-Pod credential transfer, Pod-exec permission, or RBAC grant. Verify that the pinned
scheduled path does not gain another native capability.

Chat and native administrators remain trusted. Readiness loss does not terminate an established
Gateway-to-Agent connection or stop cron. A trusted policy change can precede readiness propagation;
OCC cannot immediately revoke a standing job. Retire the job or deny it at the MCP service. Issued
calls can complete.

Automation admission separately requires the existing reviewer `user`, no `auto_review`, and an
enabled `networkProxy` in `limited` mode. Compute must verify the exact requirements content and
read-only Agent mount, the rendered Agent launch, and its Pod, container, and image provenance
before granting transport. Refuse admission when the revision lacks either explicit setting, the
packaged CLI does not enforce the requirements, or live content, mount, or launch evidence differs.
Never fall back to `exec` to make an approved MCP call.

These controls apply to ordinary chat on the selected Agent as well as scheduled turns. The
operator's explicit Code Mode opt-out accounts for Code Mode removal; the same automation-qualified
Agent also loses the native sleep tool. Dedicated revisions without the raw opt-in retain their
existing chat configuration.

## Interface changes

### APIs

No changes.

### IAM

No changes.

### Database entities

No changes.

### Driver contracts

The Compute Driver must enforce the revision selection, managed requirements, launch verification,
and refusal behavior above for dedicated automation transport. The public operation signature does
not change.

## Simplifications

Reuse the existing revision-scoped ConfigMap and supported Codex managed requirements. No new
launcher variant, ConfigMap, or native RPC proxy is needed. No infrastructure simplifications.

## Acceptance criteria

- **AC1. Admission:** Through OCC, an exact-Agent authorized human cannot create either a model-only
  or MCP automation on a dedicated revision without API-key auth and both raw opt-in settings.
  Verify denial of runtime, PAT, ChatGPT/OAuth, credential-source, repository-credential,
  repository-network-policy, and protected native-Git modes for both empty and finite caps. A
  revision with the required reviewer, proxy, and verified effective managed requirements can
  proceed. A missing, conflicting, or unavailable `configRequirements/read` reply fails Agent
  readiness; admission refuses the unready Pod.
- **AC2. Execution:** On the packaged dedicated Harness, a genuine model-only scheduled turn exposes
  no native `exec` or sleep tool. A genuine MCP scheduled turn calls its exact approved direct
  dynamic tool; audit and independent service records prove the approved effect and no selected
  forbidden effects. Verify the existing parent gates for `remote_plugin`, `in_app_browser`,
  `skill_mcp_dependency_install`, and `tool_suggest`; pin or refuse any independently exposed
  capability. No Code Mode wrapper qualifies. Repeat the existing embedded allowed and denied
  checks.
- **AC3. Lifecycle:** Verify the controls remain in the exact selected launch after native respawn,
  container restart, and endpoint-attestation withdrawal. A conflicting native thread feature
  request cannot enable a pinned feature. A higher-precedence policy that changes an effective
  requirement fails the Agent-local readiness probe; admission refuses the unready Pod. Readiness
  loss does not stop an established connection or cron. Unsupported requirements or changed content,
  mount, Pod, container, image, or launch evidence refuse automation access.

## Delivery and verification

This RFC was submitted for human review in
[PR #6942](https://github.com/openclaw/openclaw-enterprise/pull/6942) before the Compute Driver
change. The source implementation is present; the
[current reference](../../docs/reference/agent-automations.md) owns supported behavior. Merge
requires genuine QA on the exact candidate commit for both packaged Harnesses and independent
review. Source inspection and fixture-only diagnostics do not satisfy AC2.
