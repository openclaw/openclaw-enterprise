# Permissions cheat sheet

Look up which permission OpenClaw Control Plane (OCC) checks for a public
operation. A permission is an exact `action` and `resourceKind`; a Role grants it
through an AccessBinding. Missing grants are denied, matching Restrictions
override grants, and one action never implies another. See
[Authorization](../authorization.md) for the full policy.

## Actions

| Action       | What it permits                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`     | Create a resource in its parent Installation or Namespace.                                                                                        |
| `read`       | Read a resource or include it in a list; Secret reads return metadata, not values.                                                                |
| `update`     | Change a resource or its credential.                                                                                                              |
| `delete`     | Request deletion of the exact resource.                                                                                                           |
| `deploy`     | Admit a new Agent revision.                                                                                                                       |
| `operate`    | Stop an Agent, provision its runtime credentials, write its workspace files, read its runtime status, or use a bound Secret or credential source. |
| `administer` | Run Installation administration, read the exact Agent’s runtime log text. It does not imply `read`, `deploy`, or other actions.                   |
| `use`        | Enter an Agent runtime as a human with an exact runtime-role assignment. Does not imply OCE management permissions.                               |
| `read_logs`  | Read the exact Agent’s runtime log text without `administer`. Not granted by bootstrap; grant it through a Namespace Role.                        |

## Resources and scopes

This is the set checked by current public operations. See
[bootstrap policy](../authorization.md#supported-policy-surface) for the grants
given to the human administrator and non-Agent bootstrap service principal.
Rerunning bootstrap does not add missing permissions to existing Roles.

| Resource kind                                   | Actions                                                                                     | Scope checked                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`installation`](../api.md#installation)        | `read`, `administer`                                                                        | Singleton Installation.                                                                                                                                                                                                                                                                                                                                    |
| [`namespace`](../api.md#namespaces)             | `create`, `read`, `delete`                                                                  | Installation for create; exact Namespace otherwise.                                                                                                                                                                                                                                                                                                        |
| [`configuration`](../api.md#configurations)     | `create`, `read`, `update`, `delete`                                                        | Namespace for create; exact Configuration otherwise.                                                                                                                                                                                                                                                                                                       |
| [`preset`](../presets.md)                       | `create`, `read`, `update`, `delete`                                                        | Namespace for create; list needs Namespace `read` and returns only Presets with exact `read`. Exact Preset otherwise.                                                                                                                                                                                                                                      |
| [`service_account`](../api.md#service-accounts) | `create`, `read`, `update`, `delete`                                                        | Namespace for create; exact ServiceAccount otherwise. Credential creation also uses `update`.                                                                                                                                                                                                                                                              |
| [`secret`](../api.md#secrets)                   | `create`, `read`, `update`, `delete`, `operate`                                             | Namespace collection for create; list needs Namespace `read` and returns only Secrets with exact `read`. Other actions target the exact Secret. `operate` is checked when a Secret is bound or used.                                                                                                                                                       |
| [`credential_source`](../credential-sources.md) | `create`, `read`, `update`, `delete`, `operate`                                             | Namespace collection for create; list needs Namespace `read` and returns only sources with exact `read`. Other actions target the exact source. `operate` is checked when a source is bound or deployed. `update` also needs `secret:operate` on each Secret it reads; Roles from an Installation bootstrapped before `update` existed must be granted it. |
| [`agent`](../api.md#agents)                     | `create`, `read`, `update`, `delete`, `deploy`, `operate`, `administer`, `read_logs`, `use` | Namespace for create; exact Agent otherwise. OpenClaw entry requires a human session and an exact runtime-role assignment. Bootstrap does not grant `read_logs` or `use`.                                                                                                                                                                                  |
| [`agent_revision`](../api.md#agent-revisions)   | `read`                                                                                      | Exact AgentRevision; deployment-status reads use this permission too.                                                                                                                                                                                                                                                                                      |

Namespace, Preset, Agent, ServiceAccount, AgentRevision, Secret, and credential
source lists check each returned resource. Listing Agents, ServiceAccounts or Presets also requires `namespace:read`;
listing AgentRevisions also requires `agent:read` on the parent. The
[HTTP API reference](../api.md#operations) lists exact targets and conditions for
each operation.

[Sign-in, sign-out, and session lookup](../api.md#authentication) use session
rules rather than resource permissions. Installation bootstrap and account
creation require a human session; service-key administration also accepts an
authorized Installation-scoped service key. A Namespace-scoped key cannot access
another Namespace or Installation endpoints. An Installation-scoped key still
needs its principal’s own grants; it does not inherit the issuer’s. See
[service key scope](../authentication/service-api-keys.md#request-admission-and-scope).

## Additional checks

- [Experimental personal Codex login](../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)
  requires Namespace `agent:create`, or exact `agent:read` and `agent:update` for
  an existing Agent. Start also requires `secret:create`; polling, cancellation,
  and discovery require exact `secret:operate` and the initiating actor. The
  staged login is an ordinary Secret, so other `secret:operate` holders can bind
  or project it outside these operations.

- [Channel directory lookup](../api.md#post-namespacesnamespaceidchanneldirectorylookup)
  requires `agent:create` in the Namespace, or `agent:update` or
  `configuration:update` on the exact edit target, plus `secret:operate` on the
  exact same-Namespace Secret used for the lookup.
- Model discovery for Agent creation requires `agent:create` in the exact
  Namespace. The supplied API key or service account token is used transiently; no resource is created.
- [Create](../api.md#post-namespacesnamespaceidagents), [update](../api.md#patch-namespacesnamespaceidagentsagentid), and
  [deploy an Agent](../api.md#post-namespacesnamespaceidagentsagentiddeploy) also
  require `configuration:read`, `service_account:read` for current or new
  associations, `secret:operate` for bound Secrets, and `credential_source:operate`
  for a bound credential source. At deployment the Agent’s own service principal
  also needs `secret:operate` on each bound Secret and `credential_source:operate`
  on its source.
- [Registering](../api.md#post-namespacesnamespaceidcredentialsources) or
  [updating a credential source](../api.md#patch-namespacesnamespaceidcredentialsourcescredentialsourceid)
  also requires `secret:operate` on each Secret it reads.
- [Withdrawing a credential source](../api.md#post-namespacesnamespaceidagentsagentidcredentialsourcescredentialsourceidwithdraw)
  from an Agent requires `agent:operate`; the worker rechecks it before revoking.
- [Create](../api.md#post-namespacesnamespaceidconfigurations) or
  [update a Configuration](../api.md#patch-namespacesnamespaceidconfigurationsconfigurationid)
  with Secret bindings requires `secret:operate` on each bound Secret.
- [Adopting an existing Kubernetes namespace](../api.md#post-namespaces) also
  requires `installation:administer`.
- [Provisioning Agent runtime credentials](../api.md#post-namespacesnamespaceidagentsagentidruntimecredentials)
  requires both `agent:operate` and `agent:read`.
- [Agent runtime status](../api.md#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntime)
  requires `agent:operate`, `agent:read` and `agent_revision:read`;
  [runtime log text](../api.md#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntimelogs)
  requires `agent:read_logs` or `agent:administer`, plus `agent:read`, for every
  revision of the Agent; a `read_logs` Restriction also blocks `administer`. See
  [Agent logs](../../guides/topics/agent-logs.md#who-can-see-what).
- A first [Agent deployment](../agents/deployment.md#revisions-and-deployment)
  also requires exact-Agent `read` and `operate` when the selected Compute Driver
  must create missing generated transport credentials.
- [Namespace IAM operations](../api.md#iam) require `installation:administer`
  and `namespace:read`. [Creating an AccessBinding](../api.md#post-namespacesnamespaceidiamaccessbindings)
  also requires `read` on its exact target. [Listing Backends](../api.md#get-backends)
  uses `installation:administer`; Backend and IAM policy objects have no
  separate permission resource kinds.
- [Reading the observability destination](../api.md#get-observability) uses
  `installation:administer`. The configured external service enforces its own access.

The [Namespace policy API](../authorization.md#manage-namespace-policy) accepts
the per-kind actions in the table above on `agent`, `agent_revision`,
`configuration`, `credential_source`, `preset`, `secret`, and `service_account`.
It refuses, with `400 INVALID_REQUEST`, a Role with a combination no operation
checks, such as `secret:read_logs` or `configuration:deploy`, because it would
grant nothing. On `namespace` it accepts only `read`.
It can bind an existing human Principal or a Namespace-local ServicePrincipal
to an existing exact resource, including the path Namespace itself. Exact
Namespace access does not grant access to child resources.
It cannot create Installation or Namespace-wide grants, including the collection
permission needed to create resources. Existing Namespace-wide and Group
bindings can still be listed or deleted. Groups and Restrictions cannot be
managed through this API.
