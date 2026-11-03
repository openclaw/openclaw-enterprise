# Reference

<a id="feature-reference"></a>

Use Reference to look up commands and flags, HTTP operations and permissions,
request and response fields, PostgreSQL tables, and environment variables for
the OpenClaw Control Plane (OCC).

## Cheat sheets

- [GitHub Actions](cheatsheets/github-actions.md): workflows, triggers, and blocking failures.
- [API](cheatsheets/api.md): public methods and what they do, by entity.
- [Permissions](cheatsheets/permissions.md): all IAM actions, resources, and access scopes.
- [Database entities](cheatsheets/database-entities.md): PostgreSQL tables, their purpose, and their columns.
- [Environment variables](cheatsheets/environment-variables.md): variables by topic.

## CLI

Use `occ` from a terminal to manage an Installation, Namespaces, Configurations,
and Agents. Start with [CLI setup](../guides/cli.md) to install it, connect, and
make your first request. The [command reference](cli.md) lists the available
commands, flags, and output formats.

## HTTP API

Use the HTTP API from automation or when you need an operation the CLI does not
expose. The [HTTP API quickstart](../guides/http-api.md) makes authenticated
requests and explains the responses. Use the [interactive API reference](api-explorer.md)
to inspect paths, schemas, permissions, error codes, and examples. The
[Markdown reference](api.md) provides a text-only view for browsing and site search.
Both use the generated [OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).
Follow [create and deploy an Agent](../guides/http-api-agent.md) for the complete workflow.

## Metrics

The [OCC metrics reference](metrics.md) defines application and process metrics
and the private listener configuration.

## PostgreSQL authentication

The [auth binding](postgres-auth-binding.md) defines the package interface and
pool/schema ownership for controller authentication.

## Related

<span id="features"></span>

- [Topics](../guides/topics/README.md) explains what product features do; [Configuration](configuration.md)
  and [Installation settings](settings.md) cover supported configuration.
- [Authentication](authentication.md) and [authorization](authorization.md)
  explain which credentials and permissions requests need.
- [Agent Presets](presets.md) defines reusable launch settings, variables, and CRUD permissions.
- [Agent native admin UI](agent-native-admin.md) covers trusted operator access,
  exact Agent authorization, and routing limits.

<span id="drivers"></span>

- [Integrations](../guides/integrations/README.md) covers named Drivers and Backends.

<span id="platform-internals"></span>

- [Contribute](../contributing/README.md) covers development; see
  [API generation checks](../testing/local.md#repository-and-tooling-configuration)
  when changing routes or schemas.
