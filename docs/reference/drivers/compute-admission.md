# Compute admission checks

A [ComputeDriver](compute.md) can implement side-effect-free checks that let OCC
refuse a request before it stores a Configuration or Agent, creates an Agent revision,
or stops a running one. The checks read only their arguments and the Driver's
trusted Installation settings, never the backend.

## When OCC calls each check

| Method                                                                            | Called at                                                                                                                                                                                    | Refusal                                                                                                                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateConfiguration(configuration, options?)`                                  | Configuration create and update, Agent provisioning, and Preset create and update (rendered with defaults; `options.unresolved` marks unfilled variables)                                    | `ConfigurationHarnessError` answers `400` with its message. Use it for rules every topology applies; `validateHarnessAuth` applies them again at deployment.         |
| `validateHarnessAuth(harness, auth, configuration, secretBindings?, sourceType?)` | Deployment and provisioning, which require it; Agent create and update, with `null` bindings, when the binding is `runtime` or a Secret and the Configuration selects a model                | `ConfigurationHarnessError` answers `400` with its message; any other error becomes a fixed `409`. A missing method at deployment is a dependency-unavailable error. |
| `validateGatewaySettings(configuration)`                                          | Deployment, after `validateHarnessAuth`                                                                                                                                                      | `ComputeGatewaySettingError` answers `409` with its message. Leave other refusals to preparation.                                                                    |
| `validateWorkspaceSetup(harness, configuration, sandboxDriverId?)`                | Agent create with initial workspace files, Agent update while that setup is pending, deployment of an Agent with a pending or completed setup, and provisioning with initial workspace files | `ConfigurationHarnessError` answers `400`; any other error becomes a fixed `409`. Preparation applies the same rule.                                                 |
| `validateRepositoryCredentials(harness, sandboxDriverId?)`                        | Deployment with repository bindings, which requires it, Agent create and update, and the provisioning request, with repository bindings                                                      | Any error becomes a fixed `409`.                                                                                                                                     |

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
- an `env` or `env.vars` name starting `OPENAI_` or `ANTHROPIC_` in any
  case, or `CODEX_ACCESS_TOKEN`, `CODEX_CHATGPT_WORKSPACE_ID` or
  `CODEX_LOGIN_MODE`;
- on any `models.providers.<provider>`, whether or not a model setting
  selects it: a credential header in `headers` (on the provider or one of
  its models) or `request.headers`, a header name that is not a valid HTTP
  field name, and a `request.auth` other than exactly
  `{mode: "provider-default"}`. A credential header's last hyphen-,
  underscore- or dot-separated word is `auth`, `authorization`, `token`,
  `secret`, `password`, `cookie`, `credential(s)`, `signature`, `jwt` or a
  like word, or its name ends in `key` (not an idempotency, cache, dedup,
  partition, shard or sort key), before any trailing algorithm or version
  word such as `-sha256`, `-ed25519` or `-v2`; the
  [rule](../../../packages/occ/src/model-provider-settings.ts) lists them.
  The refusal quotes the header's name, never its value. On a Preset save, a
  header name that waits on a variable without a default is matched as the
  text around the variable (`Authorization{{ vars.suffix }}` is refused) and
  checked again once filled.
  A `models` that is not a list is refused too: it would hide its rows.
- once the Configuration's model policy selects a Harness and its primary
  model a supported provider: a model selection (including a `models` key or
  `modelPolicy.allow` entry) or `models.providers.<name>.apiKey` off that
  provider, and an `apiKey` that Harness refuses. OpenClaw's `openrouter:auto`
  and `openrouter:free` name the `openrouter` provider. Dedicated Codex also
  refuses a policy entry without a provider, `mediaModels.*` and `voiceModel`:
  OpenClaw calls media and voice models directly, and Codex serves only chat
  models.
  Dedicated Codex takes no `apiKey`; OpenClaw takes `${NAME}` or an
  env SecretRef to the binding's variable, through an env provider that
  allows it or OpenClaw's default env alias. An inline key is left to the
  Configuration Driver. A Preset save runs this rule too, except on a reference
  or provider key whose provider waits on a variable, or an `apiKey` whose
  value or `secrets` source does: the launch checks them once filled. A draft
  whose model policy selects no Harness is left to deployment.

These close the credential slots in a provider's `headers` and `request`.
The provider `apiKey` stays, checked against the Harness binding. The
Configuration Driver accepts the `apiKey`, the credential headers,
`request.auth.token` and `.value` and the TLS client keys only as references,
and refuses a `request.proxy.url` or model `baseUrl` with a user name or
password.
On Kubernetes a reference does not admit a credential header or a non-default
`request.auth`: model credentials come only from the Agent's Harness
authentication binding. Deployment runs OCC's model provider settings rules
(`baseUrl`, `api`, the `models` list, header names), then `validateConfiguration`,
on the stored values before the Configuration Driver validates them, so a stored Configuration that predates a
rule gets its save message.
A credential under a header name the rule does not match, in
`localService.env`, or as a literal in another `env` name that a reference
reads, still passes: the binding cannot see what a name means.

`validateHarnessAuth` applies the other rules above first, then names the
Agent's `harnessAuth.method` when its topology cannot use it (embedded OpenClaw
takes `api_key`, dedicated OpenClaw also `credential_source`, and dedicated
Codex also `codex_pat` and `oauth`), then the model provider rule above, a
channel credential reference without a Configuration Secret binding, and the
dedicated OpenClaw model catalog settings. Whether the Installation supplies
what a method needs (OAuth needs no Sandbox Driver; a credential source needs
its paired Sandbox) stays a fixed `409`.
The channel runtime rule stays at deployment: it depends on the execution mode
and the Installation's `runtime.channels`.

[SSH Compute](ssh-compute.md) runs only embedded OpenClaw (other topologies get
a fixed `409`) and names `harnessAuth.method` for any method but `runtime`,
through the same
[shared rule](../../../apps/controller/src/drivers/compute/harness-auth-method.ts).

`validateWorkspaceSetup` needs an `agents.entries` roster of `main` alone, in
any letter case (or none), and the managed workspace path (or
`/home/node/workspace` on a dedicated Harness); preparation also needs runtime
storage, an Installation setting. For a provisioning Sandbox, Compute approves only the managed workspace path
returned by its selected `configureAgent` transform. It initializes the approved
Harness PVC in a restricted private bootstrap Deployment, verifies completion,
and removes all writer Pods before Sandbox handoff. The Harness checks the
completion marker at its effective path, including OpenShell relocation. Other
workspace paths fail; Sandbox repository bindings remain unsupported.
[Docker Compute](../../../apps/controller/src/drivers/compute/docker/index.ts)
applies the same
[shared rule](../../../apps/controller/src/drivers/compute/workspace-setup-runtime.ts),
with the same messages, at Agent save and in preparation. It accepts both paths on
either topology, since one volume backs both, and also refuses `skipBootstrap`
and `skipOptionalBootstrapFiles` on `agents.defaults` or `main`.
SSH Compute applies the shared roster rule, with its message, at Agent save and
when deploying an Agent with a setup, pending or completed. With initial
workspace files it also refuses any `workspace` on `agents.defaults` or `main`
there: the host always uses a workspace it derives under the Agent's own
directory, and checks that path again at deployment.

## Related

- [ComputeDriver contract](compute.md)
- [Agents](../agents.md) and [deployment](../agents/deployment.md)
- [Configuration persistence and revisions](../../flows/configuration-driver/persistence-and-revisions.md)
