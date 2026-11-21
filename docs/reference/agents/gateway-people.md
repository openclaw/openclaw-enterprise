# Direct Control UI access

## Configured users

`GET /namespaces/:namespaceId/agents/:agentId/gateway/people` requires exact Agent
`administer` and a serving Gateway owned by the selected Compute. It lists explicit
`gateway.auth.trustedProxy.allowUsers` entries read through native `config.get`,
excluding the reserved `occ-workspace-files` machine identity. Exact configured
identities determine membership, including people who have never connected.
Removing an identity removes its row on the next read even if its profile remains.

Each row returns `identity`, nullable `profileId`, `displayName`, nullable native
OpenClaw `role`, and `hasAvatar`. The adapter enriches configured identities with
canonical, nonmerged profiles from `users.list`. For the supported `x-occ-identity`
path, OpenClaw stores the trimmed, lowercase login in the profile’s `emails` aliases.
This normalization is used only for the join; the configured identity remains
unchanged. Multiple configured identities can share a profile without losing rows.
Merged tombstones, `gateway-owner`, service profiles and ambiguous aliases do not
supply enrichment. Display names are editable presentation, not identity evidence.
No display-name, GitHub-login or profile-ID match creates membership.

Without a matching profile, or when profile enrichment fails before the request
deadline, the row retains its identity with no name, role or avatar. Native roles
are not OCC IAM Roles or a complete statement of effective scopes. The response
exposes no other linked aliases, email addresses, GitHub metadata or config values.

The corresponding `/gateway/people/:profileId/avatar` operation repeats exact
Agent authorization and checks the config-derived roster before fetching an image.
Only a currently listed profile with an avatar is eligible. Removed, excluded or
unknown profile IDs return `404`. The fixed Gateway image path accepts raster
images up to 2 MiB, follows no redirects, and returns `404` for missing images.
Both roster and avatar responses prohibit caching. Concurrent reads can share an
unfinished lookup for the same revision, endpoint and credential. Its five-second
deadline starts with the first reader; later readers do not restart it. Each HTTP
request retains its own authorization, deadline and cancellation signal. Completed
results are not cached.

An installation without the adapter returns `people: null` after authorization;
the Console hides the direct-access card without suppressing OCC sharing. Its avatar
operation returns `501`. Roster and avatar
reads return `409` after the shared predecessor stop boundary during exclusive
Gateway replacement; they remain available while the predecessor still serves. Invalid config, unsupported
authentication/header configuration, or a missing/empty native allowlist returns
`503`, not an empty list: native missing/empty allowlists do not enumerate admitted
identities. Supported OCE deployment defaults instead explicitly retain only the
machine identity, which produces zero human rows. A successful zero-human read
hides the Console direct-access card. A later
positive read reveals it. Loading and dependency failures retain the last confirmed
visibility; a search with no matches does not hide the card. A denied administration
read hides the card and clears its identities. This presentation
rule adds no authorization or Configuration-read dependency.

This is a configured-identity list, not current connections or a complete access
report. Native `config.get` describes the configuration-file snapshot; it does not
prove that every setting is applied. The list does not evaluate external ingress
or identity-provider eligibility. OCC browser delegation uses a separate native
identity for each OCE Principal; those identities do not become static allowlist
entries. This roster does not associate operator-managed identities with OCC
Principals. It creates no OCC accounts, grants no access and changes no native roles. See [Gateway authentication](../drivers/kubernetes-compute/gateway-authentication.md)
for admission ownership and withdrawal limits.

See [the Access-tab procedure](../../guides/console/agent-people.md) and the
[source-backed flow](../../flows/agent-gateway-people.md).
