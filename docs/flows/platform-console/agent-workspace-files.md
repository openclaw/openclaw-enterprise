---
created: 2026-10-25
updated: 2026-10-25
last_updated_session: fix-postland-1025j
---

# Console Agent workspace files

## Overview

Trace the Agent page's **Workspace** tab, which reads and replaces files in the live
Agent's workspace. See the [parent flow](../platform-console.md) and
[Agent editing](agent-editing.md); step 6 continues that trace's numbering.

## Entry Points

- `apps/controller/src/console/agents/workspace.mts:renderWorkspaceFiles` opens from `tab=workspace`.
- It reads and writes `GET`/`PUT .../agents/:agentId/workspace/files/:name`.
- A signed-in caller needs the exact Agent read; writes follow the Agent `operate` answer.

## Flow

```mermaid
graph TD
  A["Open Workspace tab"] -->|no selected version| U["Files unavailable; no request"]
  A -->|selected version| R["GET each supported file"]
  R -->|contents| E["Editor with baseline"]
  R -->|exact missing-file 404| M["Empty editor; Save creates it"]
  R -->|denied or unavailable| D["Editor and Save disabled"]
  E -->|text differs| S["PUT file content"]
  M --> S
  S -->|filename confirmed| E
  S -->|outcome unknown| L["Save disabled until Reload"]
  L --> R
```

## Execution Trace

### 6. Read and replace live workspace files

`apps/controller/src/console/agents/workspace.mts:renderWorkspaceFiles` opens from
`tab=workspace` after an exact Agent read. Contents belong to the live Agent, not Configuration or version history.
With no selected version, files stay unavailable and no file request is sent. Another current version
keeps the editors, focus and caret, rereading unedited files in place; gaining or losing one rebuilds them.

The editor reads each supported file by name; the response must name that file and
include its contents. For an existing file, **Save** becomes available
when the text differs from that baseline. The comparison uses LF line endings, so
it does not rewrite an untouched CRLF file. A fresh read checks access before
restoring a draft, including an empty edit. **Reload** replaces those edits.

Returning to these parked editors applies the newest Agent operate answer the page has
read (Logs can read a newer one meanwhile): a grant makes the files editable; a revocation
makes them read-only with the explanation and keeps unsaved text. A failed permission
read keeps the previous answer. The controller still authorizes every write. Stop and
each version's **Run diagnostics** follow the same answer.

On the first read or an explicit **Reload**, only a `404` with code `NOT_FOUND`
and message `The requested workspace file was not found.` confirms the file is
missing. The operator can then choose **Save** to create it, even as an empty file.
A generic resource `404`, a denial, or an unavailable read keeps the editor and
**Save** disabled. **Reload** checks again without writing.

**Save** sends `PUT` with `{ content }` for that file and checks the returned filename. Saving neither patches Configuration nor admits
a version. If the outcome is unknown, **Save** stays disabled until the operator chooses
**Reload** and the controller returns the file contents or that same missing-file
response. The editor never repeats the write automatically.

The [creation trace](../platform-console.md#3-authorize-the-selected-page-resource)
covers initial channel settings and Secret bindings.
`apps/controller/src/console/agents/create.mts` submits `initialWorkspaceFiles`
and `workspaceDefaultsId`. OCC stages these privately for Compute's initialization
before execution; no gateway is needed. The [workspace flow](../workspace-files.md) owns
authorization, native transport, initialization, retries, and cleanup. Live editing requires
deployment.

## Debugging and Verification

- A missing file is confirmed only by the exact `404` described above; any other
  failure keeps **Save** disabled.
- After an unknown write outcome, choose **Reload** and compare the returned contents
  before saving again.

## Related docs

- [Workspace files flow](../workspace-files.md)
- [Agent workspace files reference](../../reference/agents/workspace-files.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-25: Move step 6 from [Agent editing](agent-editing.md) unchanged. (finding 2488)
