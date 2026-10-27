# Codex permission profile definitions

Use `drivers.plugin.configuration.permissionProfiles` when native Codex needs
an operator-supplied definition for a named permission profile. Configure the
bundled `codex-plugin` Driver in trusted Installation YAML:

```yaml
drivers:
  plugin:
    id: codex-plugin
    configuration:
      permissionProfiles:
        custom-investigation:
          extends: ":workspace"
          network:
            enabled: true
```

Apply the Installation configuration to both API and worker processes, then
deploy a new Agent revision. The new revision stores the validated definitions
even when the Agent selects no plugins. Existing revisions retain their original
definitions. No catalog reader or discovery credential is needed to configure
these definitions.

## Supported values

Each profile requires an `extends` string and a `network` object containing only
the boolean `enabled`. A parent can be `:read-only`, `:workspace`, or another
profile in the same map. Unknown parents, inheritance cycles, and inheritance
from `:danger-full-access` are rejected. Names must be nonempty, must not start
with `:`, and must not contain control characters or unpaired Unicode surrogates.
Table keys and parent strings are quoted when rendered into native TOML.

Unknown fields are rejected at every level. Raw TOML, filesystem grants, proxy
settings, credentials, and default-profile selection are not supported here.
Omitting `permissionProfiles` adds no definitions and changes no native default.
Never put tokens or other secrets in these definitions; revision readers can
read the saved configuration.

Definitions do not select a profile or override managed requirements. Native
Codex resolves its selected profile and enforces those requirements. OCE's
execution admission, Sandbox, and network controls remain separate. A native
configuration rejection keeps the runtime unready.

## Rendering and readiness

The Plugin Driver validates definitions at startup and supplies its nonsecret
runtime snapshot during deployment admission. Compute renders the saved
definitions into the Agent's generated `CODEX_HOME/config.toml`. It rejects
unsupported saved settings instead of reading the current Driver configuration.

The authentication probe loads that generated file. It retains its explicit
model endpoint, read-only sandbox, no-approval policy, disabled tools, temporary
working directory, ignored rules, timeout, and output validation. Login success
alone does not establish readiness; the probe must complete its model turn.

If readiness fails because a required profile is undefined, obtain the required
definition from the account administrator, update trusted Installation settings,
and deploy a new revision. Do not replace managed requirements or select a more
permissive default to suppress the failure. Keep private profile names and native
output out of public diagnostics.

See the [Plugin Driver contract](plugin.md),
[Harness execution flow](../../flows/harness-execution-topology.md), and
[probe verification limits](../../testing/docker.md#verify-codex-startup-probe-recovery).
