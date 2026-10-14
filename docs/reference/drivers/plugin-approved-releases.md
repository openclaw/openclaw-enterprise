# Approved OpenClaw plugin releases

The bundled OpenClaw Plugin Driver (`occ-plugin`) offers its compiled Diffs entry
plus any exact plugin releases the Installation administrator approves in its
Driver configuration. Each approved entry names one npm or ClawHub package, one
exact version, and the integrity that installation must reproduce. Agent editors
select an approved entry by ID; they cannot supply a package, version, or source.
The [bundled Driver reference](plugin-bundled.md) owns the rest of `occ-plugin`
behavior, and the [approval guide](../../guides/topics/plugins-approve-releases.md)
gives the operator procedure.

## Configuration

Add entries under `approvedPlugins` in trusted Installation configuration:

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
          integrity: sha256-<base64 archive digest>
          toolNames: [acme_search]
```

| Field         | Requirement                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `nativeId`    | The plugin's native OpenClaw ID. Its selection ID is `occ-plugin:<nativeId>`. Unique across the catalog, including `diffs`.   |
| `name`        | Display name, 1–128 characters.                                                                                               |
| `source`      | `npm` or `clawhub`. No Git, URL, path, archive, or marketplace source is accepted.                                            |
| `packageName` | npm-style package name, optionally scoped.                                                                                    |
| `version`     | One exact semantic version, optionally with a prerelease. Ranges, tags, and build metadata are refused.                       |
| `integrity`   | `npm`: the tarball's `sha512-` integrity. `clawhub`: the archive's `sha256-` integrity that OpenClaw records for the install. |
| `toolNames`   | 1–64 native tool names the plugin registers. Names must be canonical, not reserved, and owned by one plugin only.             |

The list holds at most 64 entries, and entries accept no other fields. The
controller validates the configuration at startup and refuses to start when an
entry is invalid. Changing the list requires a controller restart.

## Admission and runtime

Agent save and deployment reject selections the configured catalog does not
offer. At deployment, the Driver's `bindReleases` records each selected approved
entry under `releases` in the AgentRevision `plugins` snapshot. Compute delivers
that snapshot in the plugin runtime manifest, and the Pod installs the recorded
release on every start, so removing or changing an entry affects only later
saves and deployments. Diffs is compiled into every runtime and is not recorded.

Preparation installs a ClawHub entry as `clawhub:<packageName>@<version>` with
`--force --no-enable`, and an npm entry as `<packageName>@<version>` with
`--pin --force --no-enable` like Diffs; OpenClaw accepts `--pin` only for npm. It then inspects the install and requires the recorded source,
package (`clawhubPackage` for ClawHub, `resolvedName` for npm), version, and
integrity to match the admitted release. A mismatch keeps the gateway unready.
Each start installs fresh: the gateway's state volume keeps OpenClaw's install
records, so startup first removes every persisted record and restores the
configuration that removal edits. The one install then runs with no record that
a substituted archive could claim, so OpenClaw loads none of its code. Plugin
installation and inspection run without the container's credential-named
environment variables, such as the model key.
Package downloads use the Agent's existing public HTTPS egress.

## Limits

- An OpenClaw Agent can select one plugin: Diffs or one approved release. Saves,
  updates, and deployments refuse a second selection. With two installs in one
  start, OpenClaw would treat a second archive that declares the first plugin's
  ID as an update and run that archive's Doctor migration before verification.
  The limit can lift when OpenClaw refuses an unverified package before it
  updates an existing install.

- Approval is an Installation-wide trust decision to run the package's code in
  every Agent that selects it. OCE does not read ClawHub's scan or moderation
  status; review the release before approving it.
- Approval is also the capability consent OpenClaw asks for: the Pod installs an
  approved release with `--accept-capabilities`, accepting every capability the
  release declares. Review those capabilities before approving.
- Approved entries support the same embedded OpenClaw policy as Diffs:
  `provider_default` and `none`, tool enablement, and approvers. They add no
  per-call review.
- Approval does not grant credentials or change Agent tool policy. A
  Configuration that denies every tool still blocks the plugin's tools.
- The Codex Plugin Driver has no approved list, and SSH Compute rejects plugin
  selections.
- An approved plugin runs inside the gateway container and adds to its memory.
  With `@openclaw/lobster` loaded, a 1 GiB gateway limit was OOM-killed and a
  2 GiB limit was not. Size `resources.gateway.limits.memory` for the plugins
  you approve.
- There is no API or Console control for the list.
- Verification follows installation. The pinned OpenClaw CLI cannot take an
  expected digest, so the Pod downloads and unpacks the archive and installs its
  npm dependencies (lifecycle scripts disabled, versions resolved at install time)
  before comparing digests. It loads no plugin code before the comparison, and a
  mismatch stops before the native gateway starts. Withholding credential-named
  variables keeps them out of the CLI's environment; it does not stop code that
  runs as the same user from reading the container's process environment. The pin does not cover those
  dependencies or the registry origin.

## Source and verification

- [Configuration and catalog](../../../apps/controller/src/drivers/plugin/index.ts) and
  [shared translator](../../../apps/controller/src/drivers/plugin/runtime-translator.ts).
- [Runtime manifest](../../../apps/controller/src/drivers/compute/plugin-runtime.ts) and
  [Pod installation](../../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts).
- [Agent plugin runtime flow](../../flows/agent-plugins.md).

Conformance tests use recorded ClawHub install-record shapes. The real-runtime lane
in the [testing guide](../../testing/plugins.md#approved-clawhub-release) installs
from the live ClawHub registry with a released runtime image, including replay after
an approval change and refusal of a mismatched digest.
