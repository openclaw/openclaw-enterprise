# Settings reference

For `OCC_METRICS_ENABLED`, `OCC_METRICS_HOST`, `OCC_METRICS_PORT`, and their
private-listener boundary, see [OCC metrics](metrics.md).

Use this reference to configure the OpenClaw Enterprise controller and worker,
local Compose stack, PostgreSQL and its migrations, and Drivers. Development
uses local admission. The default Compose profile uses PostgreSQL and the
bundled Docker Compute and filesystem
Configuration Drivers; choose the Kubernetes profile in [Local Setup](../guides/quickstart.md)
to deploy an Agent.
Production reads Installation settings and selected Driver options from
trusted startup YAML and requires durable state, the singleton Installation,
and user session authentication. Both development and production
support reviewed bundled and installed IAM, Compute, Sandbox, and Configuration
Drivers. Production and explicit `OCC_CONFIG_PATH` Kubernetes startup
configurations select the bundled Secret Driver for Namespace-owned Secret storage.
Default Compose/PostgreSQL development without trusted startup YAML does not
enable Namespace-owned Secret storage.
PostgreSQL-backed Installations may additionally select the bundled ChatGPT
Service Account Driver.

For packaged Kubernetes deployment, immutable image inputs, operator-provisioned
Secrets, dedicated migration credentials, and exact network selectors, see
[Production Kubernetes deployment](../guides/deploy.md).

For the bundled Agent runtime image and its build recipe, see
[`deploy/runtime`](../../deploy/runtime/README.md).

The controller reads environment variables directly from its process. It does
not automatically load `.env` or [`.env.example`](../../.env.example). Export values
in your shell, pass them inline, or explicitly use Node's `--env-file` option.
The checked-in example documents local Compose and PostgreSQL variables, but the
controller still reads only values passed into its process.

If an ignored local `.env` file contains the complete required configuration,
load it explicitly:

```bash
node --env-file=.env apps/controller/src/server.mjs
```

`OCC_CONFIG_PATH` separately selects the trusted Installation startup YAML. The
path must be absolute and is required in production; development can omit it
to use its existing local defaults. Both processes read the same closed-schema
document containing `occ` and required Configuration, IAM, Compute, and Secret
Driver selections. Development without this YAML does not select the Secret
Driver or create Namespace-owned Secret storage. PostgreSQL-backed Installations
can also configure the optional
[ChatGPT Backend and its ServiceAccount Driver](backends.md#installation-configuration);
only the API reads its admin Secret. See
[Installation startup configuration](configuration.md#installation-startup-configuration)
for the complete document shape. OCC resolves its singleton Installation internally.

The optional `logging` block in the same startup YAML controls the shared OCC
operational logging level:

```yaml
logging:
  level: info
```

`level` accepts `debug`, `info`, `warn`, or `error` and defaults to `info` when
omitted. The block is closed: unknown logging keys or invalid levels fail
startup. API, worker, migration, and bootstrap processes read it at startup. A
later authorized Agent deployment freezes the same level into the admitted
AgentRevision used by gateway and Codex runtimes. This setting is not persisted
as an Installation resource and does not configure OTLP export. Remote export is
configured only in operator-owned OpenTelemetry Collector files mounted by
Compose or Helm. Use the [observability guide](../guides/observability.md)
for setup and verification; the [common logging flow](../flows/common-logging.md)
traces the lifecycle.

When a production or explicit Kubernetes startup YAML is used, the required
`drivers.secret` selection currently supports the bundled
[Kubernetes Secret Driver](drivers/kubernetes-secret.md). It is loaded from the
same startup YAML, stores Namespace-owned Secret values in the backing
Kubernetes namespace, and exposes only metadata through OCC. Secret value updates
do not restart workloads; explicitly redeploy or restart each consuming Agent to
consume the current value. The selected Secret Driver is not a Credential Gateway, SecretBroker,
rotation service, or credential issuer.

The optional `drivers.sandbox` selection currently supports the bundled
[OpenShell SandboxDriver](drivers/openshell-sandbox.md) with the bundled Kubernetes
Compute Driver. It is loaded from the same startup YAML, injected into the
Kubernetes Compute Driver before workers reconcile revisions, and fails startup
when paired with SSH or an installed Compute Driver. OpenShell-selected Agents must use
dedicated Codex execution; embedded OpenClaw remains unsupported for this
SandboxDriver. The bundled OpenShell Sandbox also requires an `openshell`
[Backend](backends.md#openshell-gateway) and a matching
`drivers.credential_gateway` selection of the
[OpenShell Credential Gateway](drivers/openshell-credential-gateway.md).

For contributor test variables, fixtures, and commands, see the
[testing guides](../testing/README.md).

## Deployment and startup

[Local Setup](../guides/quickstart.md) covers the Kubernetes development profile
and its initial control-plane checks. The [deployment guide](../guides/deploy.md)
covers production preparation, Helm installation, Agent verification, and
recovery. The references below define supported settings, including their
defaults, precedence, and security requirements.

## Configuration owners

- [Development controller settings](settings/development.md) owns development inputs, optional controller environment, and fixed development security settings.
- [Production controller settings](settings/production.md) owns production API inputs, Installation bootstrap output, and Helm log collection.
- [Worker, Compose, and PostgreSQL settings](settings/operations.md) owns worker environment, local services, storage, and migration tooling.
- [Programmatic settings](settings/programmatic.md) owns TypeScript constructor options for controller composition, Drivers, and the durable queue.

The startup YAML and logging-level contract above applies across these pages.
Each field table remains defined by its linked owner.
