# Gateway people

`GET /namespaces/:namespaceId/agents/:agentId/gateway/people` requires exact Agent
`administer` and a serving Gateway owned by the selected Compute. It returns
`people`: native profile IDs, display names, effective OpenClaw roles (or `null`
when no named role applies), and avatar availability. The corresponding
`/gateway/people/:profileId/avatar` operation has the same permission and returns
a raster image or `404`. Both responses prohibit caching. An installation without the runtime adapter
returns `501` after authorization; the Console hides the card.

The roster omits merged aliases and the shared workspace/loopback owner profiles.
It exposes no linked identity aliases, emails or GitHub metadata. It lists profiles
already known to OpenClaw, not current connections or identity-provider grants;
profiles can remain after access is removed. This creates no OCC accounts, grants
no access and changes no native roles. Authentication and admission remain with
the configured ingress, independently of the identity provider chosen there.

See [the overview procedure](../../guides/console/agent-people.md) and the
[source-backed flow](../../flows/agent-gateway-people.md).
