---
rfc: ../rfcs/0029-dedicated-openclaw-plugin-import.md
---

# Deliver imported plugins to dedicated OpenClaw Agents

- **ID** RFC-0029
- **Delivery status** In progress
- **Source baseline** `516ee6d87`

## Implementation

1. Implement [Namespace-owned publication](../rfcs/0029-dedicated-openclaw-plugin-import.md#publication-authority). Extend the [Plugin Driver contract](../../packages/contracts/src/drivers/plugin/index.ts) and OCC admission for the server-resolved Namespace. Authorize and audit publication and use. Keep release bytes and immutable metadata together in OCC-owned storage. A release referenced by an Agent revision must remain available for retry and restart.
2. Extend the [managed catalog](../../apps/controller/src/drivers/plugin/managed-catalog.ts) to inspect one package or selected marketplace entry. Return the effective component preview and its digest. Preserve the selected skill trees. Offer each admitted hosted descriptor as a scoped connection template. On CredentialSource creation, resolve its endpoint from the published release. The Credential Gateway accepts the matching source and the Agent owner binds it separately. Expose publication in the OCE Console and the published release in the existing Agent picker.
3. Extend [Compute preparation](../../apps/controller/src/drivers/compute/plugin-runtime.ts) and the [Kubernetes launcher](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts) to verify and expose the selected skill trees and server descriptors on deployment. Use the existing credential discovery and [request enforcement](../../apps/controller/src/drivers/sandbox/openshell-plugin-policy.ts) for hosted tools.
4. Enforce managed-mode skill installation refusal in the pinned OpenClaw Gateway, before registry access, installation or workspace mutation. Carry the native control in the OCE runtime and surface the refusal to a native client. Update the [operator workflow](../../docs/guides/topics/plugins-configure.md), [plugin reference](../../docs/reference/agent-plugins.md), [runtime flow](../../docs/flows/agent-plugins.md) and [managed mode reference](../../docs/reference/agents/gateway-managed-mode.md) when each behavior ships.

## Move enforcement to the Credential Proxy Driver

The first implementation uses the existing dedicated OpenShell Sandbox and Credential Gateway. When the execution-scoped Credential Proxy Driver takes ownership, it must resolve the same Namespace template and source into a revision grant, classify MCP requests and enforce the literal tool names before forwarding the token. Its worker must bind requests to that execution and withdraw access on revocation. The acceptance test must exercise a permitted and denied call against one real server and verify which requests arrive there. An Installation that selects today's Credential Proxy Driver cannot register these template sources.

## Verification

- Through the Console, import a skill-only package and deploy version 1 to a dedicated OpenClaw Agent. Ask the Agent to use a supporting file that gives a result absent from the prompt. Verify the actual worker result. Restart from the same Agent revision with the import source unavailable and repeat.
- Publish a changed skill as version 2. Verify publishing alone preserves version 1 on the running Agent. Select and deploy version 2, check the changed result in a fresh turn, then deselect, deploy and verify the skill leaves discovery. Compare the selected revision with the files exposed to that Gateway.
- Select two releases with the same effective skill name and verify deployment is refused. After a valid deployment, add a same-name workspace skill with a different instruction and result. Verify the turn refuses the conflicting source and never returns the workspace result. Remove the conflict and verify the imported version works again. Exercise a skill exceeding a per-file or per-skill limit, then combine individually admissible skill trees above the 8 MiB turn limit. Verify the error identifies the failed stage and no partial skill reaches a worker.
- Repeat import with a hosted-server-only package and a mixed Claude marketplace entry. Inspect the reported unsupported components. Discover and select a harmless authorized tool, then verify a real call from the dedicated worker and its result. For the mixed package, exercise its skill and selected tool in the same workflow.
- Publish the same package name and version with different files in two Namespaces. Verify each Agent selects its own release. Use the other release ID to exercise denied reads, saves and deployments. Exercise an unauthorized publication, malformed or escaping packages, and a digest mismatch through the actual APIs. Check retained releases and Agent state after failure. On a managed Gateway, attempt native skill installation through its RPC and verify refusal before file or dependency changes. Check the OCE-selected skill still works.
- Register integration coverage in the owning CI lanes. Record runtime image digest, launched binary version, selected release digest and assertion results against the [dedicated OpenClaw setup](../../docs/testing/openshell.md#native-openclaw-with-k3d). Capture the Console selection and result separately from fixture coverage.

All implementation and runtime checks are pending.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-05 01:55 UTC. Drafted against `516ee6d87` for Codex session `01a1a93c-472f-70c0-b038-f7f673ffdc1e`.
