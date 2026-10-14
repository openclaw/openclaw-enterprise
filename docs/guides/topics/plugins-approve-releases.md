# Approve a ClawHub plugin release

Approve one exact ClawHub plugin release so embedded OpenClaw Agents can select
it, then select and deploy it like Diffs. Only the Installation administrator
can approve a release: the list lives in trusted Installation configuration.
The [approved release reference](../../reference/drivers/plugin-approved-releases.md)
defines each field and its limits.

## Before you start

- The Installation selects the bundled OpenClaw Plugin Driver
  (`drivers.plugin.id: occ-plugin`), and you can edit its Installation
  configuration and restart the controller.
- You have reviewed the plugin's source, publisher, and declared capabilities.
  Approval lets every Agent that selects it run the package's code, and it
  accepts those capabilities on the plugin's behalf; OCE does not check ClawHub's
  scan or moderation status for you.
- A disposable OpenClaw environment with no credentials or Agent data, used only
  to read the release's identity.

## Record the release identity

In the disposable environment, install the exact version you reviewed, then
inspect it. Replace the package, version, and plugin ID:

```bash
openclaw plugins install 'clawhub:@acme/openclaw-search@1.4.2' --no-enable
openclaw plugins inspect acme-search --json > acme-search.json
```

From `acme-search.json` and the installed plugin's manifest, record:

| Approved field | Source                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| `nativeId`     | `plugin.id`                                                             |
| `packageName`  | `install.clawhubPackage`                                                |
| `version`      | `install.version`, which must equal `plugin.version`                    |
| `integrity`    | `install.integrity`, beginning `sha256-`                                |
| `toolNames`    | `contracts.tools` in `openclaw.plugin.json` under `install.installPath` |

Use `source: clawhub` and a display `name`. If `install.integrity` is missing
or does not begin with `sha256-`, the release cannot be approved. Take tool names
from the manifest, not `inspect --runtime`: a plugin that registers its tool
through a factory reports an empty name list there. ClawHub's package detail
publishes the same artifact SHA-256 as hex; its base64 form after `sha256-` is
the `integrity` value, so you can cross-check the two.

Read what the tools can do before approving. A plugin tool can run shell commands
or reach external services on its own, even when the Configuration denies the
core `exec` tool.

## Approve it

Add the entry to the Installation's `occ-plugin` configuration, keeping any
existing entries:

```yaml
drivers:
  plugin:
    id: occ-plugin
    configuration:
      approvedPlugins:
        - nativeId: acme-search
          name: Acme Search
          source: clawhub
          packageName: "@acme/openclaw-search"
          version: 1.4.2
          integrity: sha256-<value from install.integrity>
          toolNames: [acme_search]
```

Restart the controller. It refuses to start and names the field when an entry
is invalid, for example a version range or a missing integrity.

## Select and deploy it

Follow [Configure Agent plugins](plugins-configure.md), using the selection ID
`occ-plugin:acme-search` in place of `occ-plugin:diffs`. An OpenClaw Agent can
select one plugin, so remove Diffs from the Agent first. The deployment returns
an AgentRevision whose `plugins.releases` records the approved entry. A
`succeeded` deployment without a `PLUGIN_INSTALL_FAILED` warning means the Agent
installed that exact release and its record matched.

## Change or remove an approval

To move to a new version, record the new release identity, replace the entry,
restart the controller, and deploy each Agent again. Running revisions keep the
release they were admitted with until then. Removing an entry refuses later
saves and deployments that select it; first remove the selection from each
Agent, then deploy.
