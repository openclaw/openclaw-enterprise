---
created: 2026-10-20
updated: 2026-10-24
last_updated_session: authoring-run/2912f79a-c23d-4312-a263-1ffb0e516efc
---

# Console Agent stop and deletion

## Overview

Trace **Stop Agent** and **Delete Agent** on Agent detail and Agents list rows,
from confirmation to readback. See the [parent flow](../platform-console.md) and
[Agent editing](agent-editing.md); steps 7 and 8 continue that trace's numbering.

## Entry Points

- `apps/controller/src/console/agents/stop.mjs:createAgentStop` sends the stop request.
- `apps/controller/src/console/agents/deletion.mjs:createAgentDeletion` sends the deletion request.
- `apps/controller/src/console/agents/detail.mts:renderAgentDetail` mounts both as rows of one **Danger zone** card;
  [Agents list rows](#stop-or-delete-from-an-agents-list-row) also offer them.
- A signed-in caller needs Agent `operate` to stop and Agent `delete` to delete.

## Flow

```mermaid
graph TD
  subgraph Browser["Browser"]
    E["Confirm Agent deletion"]
    S["Confirm Agent stop"]
    L["Agents list row icon"] --> E
    L --> S
  end
  subgraph API["Controller API"]
    E --> G["DELETE exact Agent"]
    S --> T["POST exact Agent stop"]
    T -->|accepted or uncertain| U["Refresh desired state and selected version"]
    T -->|denied| I
    G -->|accepted| H["Follow the deletion receipt"]
    G -->|uncertain| X["Read the Agent without repeating deletion"]
    G -->|denied| I["Show access denied"]
    H -->|queued, running or waiting| J["Show progress and check again"]
    H -->|failed| F["Offer a confirmed retry with current delete permission"]
    H -->|deleted| K["Show Agent deleted and a link back to Agents"]
    H -->|unavailable| N["Leave the outcome unconfirmed"]
  end
```

## Execution Trace

<span id="stop-agent"></span>

### 7. Request a stop and read back the Agent

A negative [permission answer](../../reference/api.md#get-namespacesnamespaceidagentsagentidpermissions)
hides the Stop or Delete row, and the card when neither remains. If the dialog is open, it disables
confirmation, focuses Cancel and keeps the row. A missing answer keeps the rows; late advice cannot recall a request.

`apps/controller/src/console/agents/stop.mjs:createAgentStop` sends a bodyless `POST` to the
Agent’s `/stop` route. OCC’s `packages/occ/src/index.ts:stopAgent` checks Agent `operate`,
persists the requested stopped state, and queues reconciliation. Success means admission,
not that Compute has shut down. Cancel restores focus to the invoking button; submission focuses
**Refresh stop status**.

For a stopped Agent, **Request Stop again** confirms a new stop intent, even with no selected
version; the Console cannot inspect history or candidate cleanup. With no selected version
and no readable versions yet (`setNoReadableVersions`), the Stop row is hidden unless the viewer
just used it. The overview's **Runtime** row reports a requested stop.

Refresh reads desired state and selected version, not live health. Denial stays inline; changed
state updates panels in place. If the read finds deletion in progress, Agent detail switches to
the deletion status page without sending a write. An uncertain write blocks another
Stop until readback succeeds.
[Deploy to resume](../../reference/agents/deployment.md#stop-and-resume); the lifecycle
reference covers worker shutdown and preservation of versions, credentials, and state.

<span id="7-confirm-deletion-and-read-back-the-agent"></span>
<span id="7.-confirm-deletion-and-read-back-the-agent"></span>
<span id="8-confirm-deletion-and-read-back-the-agent"></span>

### 8. Confirm deletion and follow its outcome

**Delete Agent** opens a cancel-first confirmation. **Permanently delete Agent**
sends a bodyless `DELETE` to the exact Agent URL. The controller requires Agent
`delete`. A refusal stays visible on the page. If the response is lost or names
a different Agent, the Console offers a read to find out what happened without
sending another deletion.

A `202` includes a deletion receipt. The Console opens
`/console/agents/:agentId/deletion` with the Namespace and receipt ID in the URL.
`agents/deletion-status.mts:renderDeletionStatus` reads only the status endpoint,
so reload and browser history work after the Agent and its grants are removed.
The receipt identifies the request; the controller still checks the signed-in
identity and current Namespace read access. Opening this link while signed out
preserves only that read destination through sign-in. A different person cannot
use the receipt, and signing out clears the page and its remembered receipts.

The page follows queued, running and waiting work automatically. **Refresh deletion
status** checks now. Only `deleted` confirms completion; a missing result, access
denial or read failure stops polling and leaves the outcome unknown. **Back to
Agents** is available throughout. A reader who opens an already deleting Agent
without its receipt can follow cleanup only while the Agent remains readable.

Only failed cleanup with current delete permission offers **Retry cleanup**.
Confirmation rechecks both the failure and permission before sending a new request.
Cancel or Escape during those reads sends nothing. The controller decides who can
retry; an unclear write outcome requires a status check, never an automatic replay.

`packages/occ/src/index.ts:deleteAgent` owns deletion admission. The
[Agent deletion reference](../../reference/agents.md#deletion) covers
worker cleanup and the Namespace-owned resources it preserves.

### Stop or delete from an Agents list row

`apps/controller/src/console/agents/collection.mts:renderAgentList` rows use the
same Stop and Delete confirmations. Each row reads
[permission advice](../../reference/api.md#get-namespacesnamespaceidagentsagentidpermissions)
like its deployment, and reads it again when a retained list resumes.
Refusal disables the action and explains why; in an open confirmation, it also
disables confirmation and focuses Cancel. A stopped Agent without a selected
version has no Stop action. An accepted Stop updates its row without polling; an
accepted Delete opens its receipt. **View deletion progress** opens status from
a deleting row, using the receipt only if this session requested the deletion. If the response names a different Agent, the list reports an
unknown outcome and keeps the last observed state of both Agents. After `404`, `409`, or an
uncertain outcome, the requested row’s actions stay disabled until **Refresh** rereads it.

## Debugging and Verification

- On repeat `403`, follow the API’s retry-ownership explanation. For ordinary
  denials, check `delete` on the exact Agent; Agent `read` and
  `operate` do not authorize deletion. Any failed repeat pauses polling until a manual action. Use the displayed request ID when present.
- Match the Namespace, Agent and receipt in the status response. A missing Agent
  or a failed status check does not establish whether cleanup finished.

## Related docs

- [Agent editing flow](agent-editing.md)
- [Stop and resume](../../reference/agents/deployment.md#stop-and-resume)
- [Agent lifecycle reference](../../reference/agents.md#deletion)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-24 01:28: Follow the deletion receipt to confirmed completion, including status access and retry boundaries. (authoring-run/2912f79a-c23d-4312-a263-1ffb0e516efc - 3ace2f1205d77b815883e75b8b95c9a3f2858eee)
- 2026-10-20 08:02: Trace Stop and Delete from Agents list rows, moved from the Agent editing flow, in the accompanying merge. (8b95a6fb-7095-4556-9028-0723f32cc534 - a8fb50b1babb68f3eb759841f92b042da039248e)
- 2026-10-20 07:57: Describe deletion discovered by a stop-status read in the accompanying change. (authoring-run/28365356-ae7e-47dc-9790-888c3592251f - 6aedac546aad8308b4e9954648268f14545e39b2)
- 2026-10-20 05:00: Split from the Agent editing flow's steps 7 and 8. (docs-split-1020)
