---
created: 2026-09-09
updated: 2026-09-21
last_updated_session: codex/01a0c76f-2534-7991-932a-345782408759
---

# Console Agent editing and runtime requests

## Overview

Follow authorized Agent detail requests through draft editing, initial
credentials, live workspace files, and Agent deletion. This trace starts after
the console selects an exact Agent and ends with a rendered API response or the
return to the Agents list after confirmed deletion. See the
[parent flow](../platform-console.md) for the overall sequence.

## Entry Points

- `apps/controller/src/console/agents/detail.mjs:renderAgentDetail` loads the exact Agent and composes the detail actions.
- `apps/controller/src/console/agents/credentials.mjs:createRuntimeCredentialsPanel` submits explicitly entered credentials.
- `apps/controller/src/console/agents/workspace.mjs:renderWorkspaceFiles` opens live workspace files.
- A signed-in caller must hold each action's permission on the exact resource.

## Flow

```mermaid
graph TD
  subgraph Browser["Browser"]
    A["Read exact Agent"] --> B["Open detail action"]
    B --> C["Edit draft or provision credentials"]
    B --> D["Read or write workspace files"]
    B --> E["Confirm Agent deletion"]
  end
  subgraph API["Controller API"]
    C --> F["Authorize exact request"]
    D --> F
    E --> G["DELETE exact Agent"]
    G -->|accepted or uncertain| H["Refresh exact Agent"]
    G -->|denied| I["Show access denied"]
    H -->|exists| J["Show current Agent state"]
    H -->|not found| K["Return to Agents list"]
  end
```

## Execution Trace

### 4. Render draft, revision, or channels

`apps/controller/src/console/agents/detail.mjs:renderAgentDetail`

The detail page reads the Agent, revision list, and either the saved draft
Configuration or the selected AgentRevision. `revision=draft` reads the current
Configuration referenced by the Agent. `revision=<id>` reads that immutable
snapshot. The Selected revision badge is derived from `activeRevisionId`; the
newest revision and the viewed snapshot can both differ from that pointer.
Serving status stays explicitly unavailable because these API responses provide
no serving observation. Revision snapshots
are read-only and do not expose rollback, edit, deploy, or live-health controls.
Deletion applies to the Agent itself, regardless of the viewed revision or tab.

`apps/controller/src/console/channels.mjs:renderChannels` renders supported
Slack and Microsoft Teams channel settings for the saved draft only. Slack uses
fixed unresolved `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` environment references;
Teams uses fixed unresolved `MSTEAMS_APP_PASSWORD`. The editor requires
dedicated execution for enabled channels and may refuse native documents that it
cannot round-trip, including non-Socket Slack settings, non-standard credential
references, mixed Slack mention settings, and unsupported plugin shapes.

Saving channels first rereads the Agent and Configuration, then checks that the
Agent still references the same Configuration generation. The subsequent PATCH
sends `{ values: updatedValues }` and omits `secretBindings`, so the backend
retains existing bindings. The preflight reads do not prevent a later concurrent write.
An interrupted or unavailable PATCH reply keeps the result unknown and blocks
another channel write until Refresh. Draft channel disablement changes only
Configuration values; it does not stop a running Agent. The
[console reference](../../reference/console.md#inspect-detail-revisions-and-channel-drafts)
describes the supported edits and their deployment boundaries.

### 5. Provision initial runtime credentials

`apps/controller/src/console/agents/credentials.mjs:createRuntimeCredentialsPanel`

The **Operator-managed credentials** selection saves `{ "method": "runtime" }`
without a source field. The console explains “Configured on the runtime host;
not validated by OCC.” This mode does not request managed credential metadata
or provisioning; it still requires readable revision history and unchanged draft
state before submitting deployment. API authorization and selected-driver
compatibility checks remain authoritative.

For managed authentication methods, the saved draft reads metadata from the exact Agent's `runtime-credentials`
endpoint. The console sends masked model and Slack inputs only on explicit
submission and clears them afterward. The response reports stored groups, not
provider validity or runtime health; an uncertain response requires a status
refresh before retrying.

OCC authorizes the exact Agent, locks its Namespace and Agent, and rejects
provisioning after any historical revision exists. The selected Compute Driver
derives Secret names and verifies Namespace and Agent ownership before writing.
Kubernetes creates only missing whole Secrets, generates transport tokens on the
server, and preserves existing matching groups on retry. Neither Configuration
nor the audit event receives credential bytes. External Secret creation cannot
be rolled back by a failed database transaction, so errors require readback.

### 6. Read and replace live workspace files

`apps/controller/src/console/agents/workspace.mjs:renderWorkspaceFiles` opens from
`tab=workspace` after an exact Agent read. It bypasses Configuration and revision
history reads, because workspace contents belong to the live Agent. An Agent
without an active revision gets an unavailable explanation without file requests.

The editor issues one GET for each supported filename. A successful response
populates that file's editor; `404` permits an explicit create attempt, and other
failures leave it disabled. Save sends `{ content }` to the same exact-Agent PUT
route. It neither patches Configuration nor admits a revision. The existing
[workspace flow](../workspace-files.md) owns authorization and native file transport.
Each result stays local to its file. Unknown write outcomes require a successful
reload before another save; the editor never retries a write automatically.

Creation uses the channel editor to update the initial Configuration JSON before
its POST. It cannot send initial workspace files because the create API has no
file fields and workspace access requires a deployed gateway.

### 7. Confirm deletion and read back the Agent

`apps/controller/src/console/agents/deletion.mjs:createAgentDeletion`

The **Delete Agent** area requests explicit confirmation before sending a
bodyless `DELETE` to the exact Agent URL. The controller requires Agent `delete`
permission; a `403` stays visible on the detail page. An accepted request starts
asynchronous cleanup and keeps the detail page in a deleting state, with
**Refresh deletion status** for an exact Agent read. Only a not-found read after
an accepted or uncertain request, or when an already-deleting Agent is opened,
returns to the Agents list in the selected Namespace. An
uncertain deletion blocks another write until a successful read establishes the
current state; the browser never automatically retries the deletion.

`packages/occ/src/index.ts:deleteAgent` owns deletion admission. The
[Agent deletion reference](../../reference/agents.md#deletion) covers the
subsequent worker cleanup and the Namespace-owned resources it preserves.

## Debugging and Verification

- On `403`, check `delete` permission on the exact Agent; Agent `read` and
  `operate` do not authorize deletion. Use the displayed request ID when present.
- An accepted deletion remains in progress until the exact Agent read reports
  not found. A failed refresh does not establish whether cleanup finished.
- See [console failures](../../reference/console.md#failures-and-logout) for
  session, permission, and network recovery.

## Related docs

- [Return to the parent flow](../platform-console.md).
- [Console reference](../../reference/console.md)
- [Agent lifecycle reference](../../reference/agents.md#deletion)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-21 21:46: Trace Agent deletion, readback, and recovery from denied or uncertain requests. (01a0c76f-2534-7991-932a-345782408759 - b61c3cae6c35e28db4153eaee9b477e8f5637894)
