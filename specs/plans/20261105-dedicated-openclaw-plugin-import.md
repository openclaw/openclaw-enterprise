---
rfc: ../rfcs/20261105-dedicated-openclaw-plugin-import.md
---

# Deliver imported plugins to dedicated OpenClaw Agents

- **ID** RFC-20261105-dedicated-openclaw-plugin-import
- **Delivery status** Partial
- **Source baseline** `516ee6d87`

## Implementation

1. Implement [Namespace-owned publication](../rfcs/20261105-dedicated-openclaw-plugin-import.md#publication-authority). Extend the [Plugin Driver contract](../../packages/contracts/src/drivers/plugin/index.ts) and OCC admission for the server-resolved Namespace. Authorize and audit publication and use. Keep release bytes and immutable metadata together in OCC-owned storage. A release referenced by an Agent revision must remain available for retry and restart.
2. Publish immutable inspected releases under Namespace `publish_plugins` authority. Expose supported skills and fixed hosted MCP server descriptors in the Console and PluginDriver catalog. Create a canonical Connection Template for a hosted server only through the owning Template API.
3. Integrate canonical Source-to-Template association, Token Service acquisition, Credential Proxy deployment, discovery, dispatch, and withdrawal through their owning workstreams. The Agent grant workflow supplies saved OAuth account authorization. Verify an allowed and denied tool call against the same real provider before claiming credentialed MCP support.
4. Enable dedicated imported skill delivery only after the pinned upstream Gateway enforces reviewed-source precedence and refuses native skill installation in managed mode. Verify those controls through real Gateway RPCs and a dedicated worker turn.

## Current dependencies

The plugin import PR owns release inspection, publication, selection, and hosted descriptors. Source association, protected hosted MCP execution, OAuth grants, and the upstream Gateway controls remain required before the complete experience can be qualified. The older runtime qualification below applies to its recorded commit and runtime, which used carried Gateway changes and the earlier credential path.

## Verification

- Through the Console, import a skill-only package and deploy version 1 to a dedicated OpenClaw Agent. Ask the Agent to use a supporting file that gives a result absent from the prompt. Verify the actual worker result. Restart from the same Agent revision with the import source unavailable and repeat.
- Publish a changed skill as version 2. Verify publishing alone preserves version 1 on the running Agent. Select and deploy version 2, check the changed result in a fresh turn, then deselect, deploy and verify the skill leaves discovery. Compare the selected revision with the files exposed to that Gateway.
- Select two releases with the same effective skill name and verify deployment is refused. After a valid deployment, add a same-name workspace skill with a different instruction and result. Verify the turn refuses the conflicting source and never returns the workspace result. Remove the conflict and verify the imported version works again. Exercise a skill exceeding a per-file or per-skill limit, then combine individually admissible skill trees above the 8 MiB turn limit. Verify the error identifies the failed stage and no partial skill reaches a worker.
- Repeat import with a hosted-server-only package and a mixed Claude marketplace entry. Inspect the reported unsupported components. Discover and select a harmless authorized tool, then verify a real call from the dedicated worker and its result. For the mixed package, exercise its skill and selected tool in the same workflow.
- Publish the same package name and version with different files in two Namespaces. Verify each Agent selects its own release. Use the other release ID to exercise denied reads, saves and deployments. Exercise an unauthorized publication, malformed or escaping packages, and a digest mismatch through the actual APIs. Check retained releases and Agent state after failure. On a managed Gateway, attempt native skill installation through its RPC and verify refusal before file or dependency changes. Check the OCE-selected skill still works.
- Register integration coverage in the owning CI lanes. Record runtime image digest, launched binary version, selected release digest and assertion results against the [dedicated OpenClaw setup](../../docs/testing/openshell.md#native-openclaw-with-k3d). Capture the Console selection and result separately from fixture coverage.

Both dedicated Kubernetes cases passed on `cd62c0ed6`. The worker read and ran two skill releases, rejected a workspace conflict and recovered after its removal. The managed Gateway refused native install and upload. The hosted MCP case verified a successful native call, a proxy denial before provider access, account replacement and withdrawal. The [PR verification](https://github.com/openclaw/openclaw-enterprise/pull/4734) records the running image, source, Console walkthrough and results. The [plugin reference](../../docs/reference/agent-plugins.md) describes the supported workflow.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-05 04:37 UTC. Completed the dedicated Kubernetes verification on `cd62c0ed6`.

- 2026-11-05 01:55 UTC. Drafted against `516ee6d87` for Codex session `01a1a93c-472f-70c0-b038-f7f673ffdc1e`.
