# Agent workload tags

Each Agent owns a `tags` map of non-secret string keys and values. Agents sharing
a Configuration can have different tags. Agent and AgentRevision list/read
responses always include the map, including `{}`, in the existing `data`
envelope. Tags are visible through existing exact-resource read permissions;
do not store credentials in them.

| Agent request         | Behavior                |
| --------------------- | ----------------------- |
| Create without `tags` | Store `{}`.             |
| PATCH without `tags`  | Preserve the saved map. |
| PATCH with `tags`     | Replace the entire map. |
| PATCH with `tags: {}` | Clear the map.          |

A PATCH still requires `configurationId`, exact-Agent `update`, and
exact-Configuration `read`. For example:

```json
{
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "tags": { "usage": "personal", "team": "developer-tools" }
}
```

The map accepts at most 64 entries. Keys contain 1–128 Unicode characters and
values contain 0–1024 Unicode characters. Keys and values are case-sensitive,
with no coercion or normalization. NUL characters, null, arrays, nested objects,
and non-string values are rejected with `400 INVALID_REQUEST`. Arbitrary names,
including `__proto__`, are treated as data.

Tags use the existing Agent create/update/deploy authorization and audit paths;
a denied write changes neither the map nor revision state. A tag such as
`usage=security` grants no privileges or credential access. Trusted Driver code
can interpret supported tags during [per-revision preparation](../drivers/compute.md#workload-tags).
The platform defines no built-in `usage` policy, tag query language, or console
tag editor/filter.

Saving tags affects future deployments only. Bodyless deployment snapshots the
saved map transactionally; queued, active, and retiring revisions retain their
original tags after Agent edits and worker restarts.
