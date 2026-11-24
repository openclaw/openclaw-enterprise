# Repository credential in the policy read

`GET /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/networking` ([repository network policy](../sandbox-policies.md#repository-network-policy)) reports which credential an Agent's repository bindings select.

When the Agent has repository bindings, GET also returns `repositoryCredential`. It is absent when the Agent has no bindings or the bindings do not resolve.

- `{ "kind": "github_app" }`: the registry selects the GitHub App path.
- `{ "kind": "credential_source", "readable": false }`: a [repository token Source](../credential-sources/managed-static.md#register-a-github-repository-token) is selected, and the caller lacks `credential_source:read` on it. The caller learns nothing else about the Source. The saved list, its version and the ceiling stay readable, and the caller can still clear the list and stop the Agent.
- Otherwise the Source's `id`, `name`, `state` and repository `ceiling`, plus `effectiveRepositoryNetworkPolicy`: the saved grants narrowed to the Namespace ceiling, the registry's selected access and the Source ceiling. A Source that is missing, in another Namespace or owned by another TokenService reads `unavailable` with no ceiling.

`deliveries` lists one entry per revision of this Agent whose Sandbox may still hold the Source. GET reads them from platform state and never asks TokenService for the value or version.

| `state`        | Meaning                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`      | No activation of the expected version is recorded. The Sandbox can still hold an earlier value.                                                   |
| `confirmed`    | The Sandbox activated the version the last replacement committed, or its first value if no replacement committed since the revision was deployed. |
| `unreconciled` | A Provider write's outcome is unknown. Replacing or deleting the Source returns `409` until the Agent is stopped or redeployed.                   |

`committedSourceVersion` and `committedAt` describe the last replacement that committed while the revision existed. `confirmedSourceVersion` and `confirmedAt` describe the last version its Sandbox was observed to activate. Versions are opaque, so only equality counts. A version the Gateway accepted but the Sandbox has not activated reads `pending`.
