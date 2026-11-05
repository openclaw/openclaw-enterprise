# Agent workspace files

Use this reference to seed the workspace files of an [Agent](../agents.md) at
creation and to read or replace them in its live workspace. For procedures, see the
[workspace guide](../../guides/topics/workspace-files.md).

## Initial contents at creation

`POST /namespaces/:namespaceId/agents` accepts `initialWorkspaceFiles`, an optional
partial map of the four filenames below to strings. Replace the example Configuration ID:

```json
{
  "name": "Support assistant",
  "configurationId": "cfg_12345678-1234-4123-8123-123456789abc",
  "initialWorkspaceFiles": {
    "AGENTS.md": "Answer support questions.\n",
    "USER.md": ""
  }
}
```

Omission or `{}` uses native initialization; omitted filenames keep native
behavior. Empty strings create empty files. Values must satisfy the live-file
Unicode and 16 KiB limits below; other names and non-strings are rejected.
The API preserves whitespace and newlines. Create requests default to 448 KiB,
including JSON escaping; configured controller limits take precedence.

Creation uses existing permissions and stages inputs privately
outside Agent, Configuration, and AgentRevision. First deployment applies them
before execution. Completion prevents replay over later edits. Staged bytes are
removed after activation or Agent deletion. Pending inputs have no read/update
API; correction requires deleting and recreating the Agent.

The optional `workspaceDefaultsId` is a SHA-256 defaults identity. Console sends
all four rendered `2026.9.9` defaults with this identity. A stale identity rejects
creation with `409 RESOURCE_CONFLICT`; runtime mismatch blocks initial setup.
See the [workspace guide](../../guides/topics/workspace-files.md) and
[setup flow](../../flows/workspace-files.md) for recovery and runtime requirements.

## Live file access

Read, create, or replace `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`
in an Agent's live workspace:

```text
/namespaces/:namespaceId/agents/:agentId/workspace/files/:name
```

| Method | Operation                  | Agent permission | Response `data`     |
| ------ | -------------------------- | ---------------- | ------------------- |
| `GET`  | Read the file              | `read`           | `{ name, content }` |
| `PUT`  | Create or replace the file | `operate`        | `{ name, size }`    |

Authenticate with a session or scoped service API key. Session-authenticated
writes must pass the [CSRF checks](../authentication.md). The Agent must have a
selected version and a reachable gateway.

Embedded OpenClaw sole rosters follow the Gateway-announced default ID.
Other rosters retain the explicit main target; dedicated deployment requires it.

`PUT` accepts one `content` field:

```json
{ "content": "You are a support assistant.\n" }
```

`content` must be well-formed Unicode without NUL characters and fit within
16 KiB when encoded as UTF-8. The complete request body is limited to 97 KiB,
enough for 16 KiB written entirely in six-byte JSON escapes.
Success returns `200`. A successful `PUT` reports `size` in UTF-8 bytes and
records the Agent, file name, and outcome in the audit log.

| Error                        | Meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `400 INVALID_REQUEST`        | Invalid file name or content.                        |
| `404 NOT_FOUND`              | The requested Agent or file was not found.           |
| `409 AGENT_DELETING`         | The Agent is being deleted.                          |
| `409 RESOURCE_CONFLICT`      | The Agent is stopping, or has no running version.    |
| `413 PAYLOAD_TOO_LARGE`      | The request body exceeds 97 KiB.                     |
| `503 DEPENDENCY_UNAVAILABLE` | Workspace access is unavailable.                     |
| `503 UNKNOWN_OUTCOME`        | OCC could not confirm the write or its audit record. |

After `UNKNOWN_OUTCOME`, read the current file before deciding whether to submit
another write.

See [gateway routing](../gateway-routing.md) for transport,
[workspace-file setup](../../guides/deploy/workspace-routing.md#agent-workspace-files) to enable
access, the [HTTP API](../api.md#get-namespacesnamespaceidagentsagentidworkspacefilesname)
for schemas, and the [execution flow](../../flows/workspace-files.md) for implementation.
