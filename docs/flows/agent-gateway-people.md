---
created: "2026-10-16"
updated: "2026-10-17"
last_updated_session: authoring-run/95258c7f-1e9d-4612-a08b-e1e2ba0e49a9
---

# Gateway people flow

## Overview

The Agent overview reads the serving Gateway's human profiles and native roles.
This is a read-only runtime view, independent of OCC account provisioning and
identity-provider admission. The following paths are implemented in source;
installed proof exercises the deployed controller and Gateway separately.

## Entry Points

- Trigger: open an Agent, select **Refresh people**, or change its serving version.
- Source: `apps/controller/src/console/agents/people.mjs:renderGatewayPeople`.
- Contract: `packages/contracts/src/api/routes.ts:getAgentGatewayPeople` and
  `getAgentGatewayPersonAvatar`, under the exact Namespace and Agent.
- Authority: OCC authenticates the caller and requires exact Agent `administer`.

## Flow

```mermaid
graph TD
  UI["People card"] --> AUTH["OCC exact Agent authorization"]
  AUTH --> REV["Serving revision and Compute ownership"]
  REV --> GW["Private Gateway machine route"]
  GW --> PROFILES["Native profiles and roles"]
  PROFILES --> UI
  AUTH -->|denied| HIDDEN["Hide roster; record denial"]
```

## Execution Trace

### 1. Select the authorized runtime

`apps/controller/src/index.ts:perform`
`packages/occ/src/index.ts:getAdministerableActiveAgentRevision`

The route resolves its server-owned Namespace/Agent scope before selecting the
active revision. An authorization denial never contacts the Gateway. The HTTP
request owns a five-second deadline and aborts on client disconnect. The selected
Compute must own the revision; another Driver's endpoint is not reused.

### 2. Read profiles without creating OCC identities

`apps/controller/src/composition/gateway-people.ts:createGatewayPeopleAccess`
`apps/controller/src/gateway/people-client.ts:createNativeGatewayPeopleAccess`

Composition uses the existing private Compute endpoint and mounted gateway API
key. The native adapter connects as the existing machine identity, checks its
admin grant, and calls `users.list`. OpenClaw supplies effective native roles.
Merged aliases, `gateway-owner`, and profiles with the `occ-workspace-files`
login alias in native `emails` are excluded. Only profile IDs, display names, roles and avatar availability reach
OCC clients; linked identities, email addresses and GitHub metadata do not.

Avatar reads first load the filtered roster and return `404` for excluded or
unknown profile IDs without fetching an image. Included profiles use a fixed
native profile-avatar path at that same Gateway,
validate raster image types, bound the body to 2 MiB, and follow no redirects.
The public avatar operation repeats exact Agent authorization. Missing images
return `404`; roster and avatar responses use `no-store`.

Concurrent roster/avatar reads share only a pending `users.list` operation for
the same revision, endpoint and machine credential. Each caller resolves its
target and retains its own cancellation/deadline; the last departing reader
cancels the shared transport. The wire read has a separate five-second bound.
Completion or failure removes the entry, so later requests reread profile
exclusions rather than reuse a completed result. Authorization precedes sharing.

### 3. Render and refresh

`apps/controller/src/console/agents/people.mjs:renderGatewayPeople`
`apps/controller/src/console/agents/detail.mjs:updateCurrentAgent`

The first read keeps the card hidden and participates in the Agent overview
reveal gate. Disabled and denied reads therefore never flash a loading card.
The card renders names as text, native role labels, and local authenticated
avatar URLs with initials as fallback. The overview previews six profiles sorted
by display name. Larger rosters offer a modal side panel with the full sorted
list and case-insensitive name search. Its list scrolls independently; Close,
Escape or the backdrop dismisses it and restores focus to the launch button.
Navigation closes open dialogs. Refresh updates an open panel; a failed or
unconfigured read clears both lists and closes the panel. A failed read clears stale entries and
leaves an explicit retry. An empty roster explains that profiles appear after
connection. Denied reads hide the card and are remembered for that view to avoid
repeated audited denials. A serving-version change refreshes the roster.
An installation without the adapter returns `people: null` and hides the card
without turning normal unavailability into a failed Console read.

## Debugging and Verification

- Confirm the caller's exact Agent `administer` grant before diagnosing Gateway
  availability. An identity-provider login alone grants no OCC access.
- Verify the selected Compute owns the active revision and can read its mounted
  key. Gateway role settings must retain machine administration.
- `tests/integration/native-admin-access.test.mjs` isolates HTTP authorization
  and serialization; it does not establish native profile semantics.
- `tests/browser/console-agent-detail-2.test.mjs` exercises the production card's
  role labels, error/empty recovery, and 50-person preview/search/dismissal through
  the HTTP app.
- `tests/integration/native-admin-k3d-real.test.mjs` reads the roster through the
  installed OCC route and native Gateway RPC.

## Related docs

- [Gateway people contract](../reference/agents/gateway-people.md)
- [Agent overview](../guides/console/agent-people.md)
- [Workspace machine access](workspace-files.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-17 10:21: Share pending roster reads while retaining caller cancellation and fresh exclusions. (authoring-run/95258c7f-1e9d-4612-a08b-e1e2ba0e49a9 - 74022a945d0ec1a895c98966b88af11b13b64893)

- 2026-10-17 09:50: Clarify machine alias filtering; verify roster search independently of Agent updates. (authoring-run/c469521f-2427-4a7f-bdcd-211e9384938d - 2990608dd47c1129acbab295c4bf90f711e14d43)

- 2026-10-16 18:54: Apply filtered-roster membership to avatar reads. (authoring-run/avatar-exclusions-2596 - 630a02a5b039ab2972d40af57498e22b2fc3d1fe)

- 2026-10-16 11:07: Gate initial roster visibility with the Agent overview. (authoring-run/review-2596 - 0c0ed82a373e0608de3e59414f0bd18fb2eedbdb)

- 2026-10-16 10:27: Added the compact preview and searchable full roster panel. (authoring-run/roster-2596 - 1e905edea40d2624dfdb456f311d8e7c475a67fb)

- 2026-10-16 13:02: Added the read-only Gateway people and avatar path. (authoring-run/roster-2596 - d80d214dba75aa446bc8391f19329cb37daa2801)
