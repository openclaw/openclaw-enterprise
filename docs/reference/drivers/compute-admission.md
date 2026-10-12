# Compute admission checks

A [ComputeDriver](compute.md) can implement side-effect-free checks that let OCC
refuse a request before it stores a Configuration or Agent, admits a revision,
or stops a running one. The checks read only their arguments and the Driver's
trusted Installation settings, never the backend.

## When OCC calls each check

| Method                                                                            | Called at                                                                                                                                                                     | Refusal                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateConfiguration(configuration)`                                            | Configuration create and update, Agent provisioning, and Preset create and update (values rendered with defaults)                                                             | `ConfigurationHarnessError` answers `400` with its message. Use it for rules every topology applies; `validateHarnessAuth` applies them again at deployment.         |
| `validateHarnessAuth(harness, auth, configuration, secretBindings?, sourceType?)` | Deployment and provisioning, which require it; Agent create and update, with `null` bindings, when the binding is `runtime` or a Secret and the Configuration selects a model | `ConfigurationHarnessError` answers `400` with its message; any other error becomes a fixed `409`. A missing method at deployment is a dependency-unavailable error. |
| `validateGatewaySettings(configuration)`                                          | Deployment, after `validateHarnessAuth`                                                                                                                                       | `ComputeGatewaySettingError` answers `409` with its message. Leave other refusals to preparation.                                                                    |
| `validateWorkspaceSetup(harness, configuration, sandboxDriverId?)`                | Agent create with initial workspace files, Agent update and deployment while that setup is pending, and provisioning with initial workspace files                             | `ConfigurationHarnessError` answers `400`; any other error becomes a fixed `409`. Preparation of the first deployment applies the same rule.                         |
| `validateRepositoryCredentials(harness, sandboxDriverId?)`                        | Deployment with repository bindings, which requires it, Agent create and update, and the provisioning request, with repository bindings                                       | Any error becomes a fixed `409`.                                                                                                                                     |

A message names the setting and what the Driver accepts, never a submitted
value, in at most 256 characters. Agent provisioning also calls
`validateAgentProvisioning`; see
[initial runtime credential provisioning](compute.md#optional-initial-runtime-credential-provisioning).

## Agent save

Agent create and update read the named Configuration and check the Agent as it
will be stored, with the messages deployment uses:

1. With a Sandbox Driver selected, the execution mode must be `dedicated`. An
   omitted `executionMode` is `embedded`.
2. The Harness the Configuration selects must be approved for the execution
   mode; a Harness approved only for the other mode is refused.
3. The Compute checks above run on the values deployment would admit, after
   the Sandbox Driver's `configureAgent` and the logging policy.
   `validateHarnessAuth` receives `null` Secret bindings and applies only
   rules that depend on the Agent.

Save leaves to deployment what depends on live state or not on the Agent: a
Harness the Installation approves for neither mode, a Configuration that
selects no model or no supported Harness, ServiceAccount and credential-source
Harness authentication, a Secret binding whose Secret is gone, a Configuration
channel's Secret bindings (which it may stage after its values), and whether
the Installation provides dedicated OpenClaw or a channel runtime. A stored
Agent that fails a check still reads; its next update must fix the pair.

## Kubernetes Compute

[Kubernetes Compute](kubernetes-compute.md) keeps these rules in
[its rule module](../../../apps/controller/src/drivers/compute/kubernetes/configuration-rules.ts).
`validateConfiguration` refuses:

- an enabled `channels.<provider>` other than `slack` or `msteams`;
- a non-empty `auth`;
- an `env` or `env.vars` name starting `OPENAI_` or `ANTHROPIC_`, or
  `CODEX_ACCESS_TOKEN`, `CODEX_CHATGPT_WORKSPACE_ID` or `CODEX_LOGIN_MODE`;
- an `authorization`, `api-key` or `x-api-key` header on a selected model
  provider or one of its models.

`validateHarnessAuth` applies these first, then names the Agent's
`harnessAuth.method` when its topology cannot use it (embedded OpenClaw takes
`api_key`, dedicated OpenClaw also `credential_source`, and dedicated Codex
also `codex_pat` and `oauth`), a provider `apiKey` other than the Harness
authentication reference, a channel credential reference without a
Configuration Secret binding, and the dedicated OpenClaw model catalog
settings. Whether the Installation supplies what a method needs (OAuth needs
no Sandbox Driver; a credential source needs its paired Sandbox) stays a fixed
`409`.
The channel runtime rule stays at deployment: it depends on the execution mode
and the Installation's `runtime.channels`.

`validateWorkspaceSetup` needs an `agents.entries` roster of `main` alone, in
any letter case (or none), and the managed workspace path (or
`/home/node/workspace` on a dedicated Harness); preparation also needs runtime
storage, an Installation setting. Kubernetes Compute first refuses any Harness
in a Sandbox, with a `409` naming the Sandbox: its Sandbox carries no workspace
initializer, and OpenShell moves the OpenClaw workspace to its mount.
[Docker Compute](../../../apps/controller/src/drivers/compute/docker/index.ts)
applies the same
[shared rule](../../../apps/controller/src/drivers/compute/workspace-setup-runtime.ts),
with the same messages, at Agent save and in preparation. It accepts both paths on
either topology, since one volume backs both, and also refuses `skipBootstrap`
and `skipOptionalBootstrapFiles` on `agents.defaults` or `main`.

## Related

- [ComputeDriver contract](compute.md)
- [Agents](../agents.md) and [deployment](../agents/deployment.md)
- [Configuration persistence and revisions](../../flows/configuration-driver/persistence-and-revisions.md)
