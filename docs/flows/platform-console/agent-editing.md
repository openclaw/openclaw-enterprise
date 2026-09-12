# Console Agent editing and runtime requests

Follow authorized Agent detail requests through draft editing, initial credentials, and live workspace files. See the [parent flow](../platform-console.md) for its context and overall sequence.

## Execution trace

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
Agent deletion is unavailable because the API has no Agent delete operation.

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

The saved draft reads metadata from the exact Agent's `runtime-credentials`
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

## Related

- [Return to the parent flow](../platform-console.md).
