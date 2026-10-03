# Install the standard Codex Preset

Install the [Standard Codex](../../../deploy/presets/standard-codex.json) Preset in a ready
Namespace through Installation defaults or the existing Preset API. It creates drafts for a dedicated
Codex Harness connected to its own separate OpenClaw gateway. The template
requests cached hosted search and allows the hosts used to build OCE from source.

**This is a launch template, not a Pod-wide network isolation guarantee.**
Read the enforcement boundary below before deploying.

## Prerequisites

- Preset create/read access and the normal Agent and Configuration permissions.
- An Installation with dedicated Codex execution and compatible gateway, Codex
  plugin, and Codex app-server images. The plugin must support
  `appServer.networkProxy` and `tools.web.search.openaiCodex.mode`; Codex must
  support named permission profiles and its managed network proxy. Do not infer
  support from a saved Configuration or a ready Pod.
- Working native Linux sandbox enforcement in the Harness environment. For
  Kubernetes, follow the [runtime and seccomp setup](../../testing/kubernetes.md).
  Do not select a SandboxDriver that replaces this policy with external
  containment unless its policy has independently been verified.
- A model available to your credential and supporting Codex hosted search, plus
  the model API key and permission to create a Secret in the current Namespace. Follow [Harness authentication](../../reference/harness-execution.md#harness-authentication)
  for credential authorization and delivery.

## Install and select

To include the three [bundled Presets](../../reference/presets.md#configuration-inventory) automatically, add this to the Installation YAML
selected by `OCC_CONFIG_PATH`, then restart the API:

```yaml
presets:
  includeDefaults: true
```

The API adds missing copies to existing and new Namespaces. Existing same-name
Presets are preserved. Omit the setting or use `false` to disable automatic
inclusion; saved copies are retained. See [permissions and restart behavior](../../reference/presets.md#installation-defaults).

For manual installation in one Namespace instead, from the repository root, use the authenticated request in
[Create a Preset](agent-presets.md#create-a-preset), replacing its
`--data-binary @preset.json` argument with:

```bash
--data-binary @deploy/presets/standard-codex.json
```

The POST returns HTTP `201`. A duplicate name returns `409`; read the existing
Preset and review it before replacing its template through PATCH. Updating the
bundled file does not overwrite an installed same-name Preset. PATCH existing
copies to receive the build allowlist; existing Agent drafts and deployments
keep their independent Configuration until explicitly updated and redeployed.

Open **Agents → Create Agent**, choose **Standard Codex**, and supply:

| Variable      | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `name`        | A unique Agent name.                                                                    |
| `model`       | Your available Codex model ID, without the `codex/` prefix; for example, `gpt-6-astra`. |
| `modelSecret` | The model API key, entered in a masked password field.                                  |

Select **Use Preset** and review the draft; the API key remains masked.
**Create Agent** stores it as a Secret in the current Namespace and binds that
Secret to the Agent. The template needs no Namespace ID or existing Secret ID. Complete the
existing [credentials and deployment procedure](../../reference/console/create-and-deploy.md#initial-runtime-credentials),
including the Agent's authorization to use its model Secret and gateway runtime
credentials. The template keeps `${APP_SERVER_URL}`, `${APP_SERVER_TOKEN}`,
and the gateway password SecretRef unresolved. Compute supplies transport
credentials; the model credential belongs only in the dedicated Harness.

The native model catalog contains only your selected `codex/<model>`, with
an explicit Codex runtime and an unreachable direct HTTP base URL. This keeps
model execution on authenticated app-server transport. There are no selected
optional plugins, channels, browser, web fetch, or elevated execution.

## Build network allowlist

The template grants these exact hostnames with value `allow` under
`plugins.entries.codex.config.appServer.networkProxy.domains`:

| Hosts                                      | Observed use                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `github.com`                               | Git access, verified with the pinned Carapace source tag.                     |
| `codeload.github.com`                      | The docs site's pinned Carapace source archive.                               |
| `registry.npmjs.org`                       | pnpm bootstrap and workspace, docs, and Storybook packages.                   |
| `nodejs.org`                               | Node.js toolchain archive and checksum manifest.                              |
| `go.dev`, `dl.google.com`                  | Go release metadata, toolchain archive, and its download redirect.            |
| `proxy.golang.org`                         | Go modules and automatic toolchain selection.                                 |
| `sum.golang.org`, `storage.googleapis.com` | Automatic Go toolchain checksum verification and redirected archive download. |

These hosts were observed on 2026-09-24 while building source revision
`63a70947fed440a875b2e6338d0a22500f9a9f5e` on Linux amd64 with Node 24.16.0,
pnpm 11.15.1, and Go 1.27.0. A second fresh container repeated the build with
only these hosts permitted by an HTTPS CONNECT proxy. Both runs started with
empty package/module caches and no installed project dependencies. The trace
recorded destination hostnames, including redirects, without decrypting TLS or
recording credentials. Direct external access was blocked by an internal
container network; an unlisted hostname was rejected by the proxy.

The verified commands, from a clean repository root, were:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm credentials:build
pnpm cli:build
pnpm cli:check
pnpm cli:test
pnpm docs:install
pnpm docs:build
pnpm storybook:install
pnpm storybook:build
```

Toolchain archives were verified against their published checksums. A separate
cold module cache also exercised Go 1.26.0 automatically downloading Go 1.27.0
from `go.mod` before building the CLI. This source-build proof covers the
workspace, credential packages, Go CLI, docs, and Storybook. It excludes OCI
image builds, browser downloads, cluster provisioning, other operating systems,
and execution inside a deployed Codex Harness. Repeat the trace when dependency
pins or build targets change; a module's import hostname need not be an egress
host when Go downloads it through its module proxy.

## Enforcement boundary

The native bridge requests a workspace-write permission profile with its managed
network proxy enabled, `mode: limited`, and the build allowlist above. The
shipped map has no wildcard grants. Upstream proxies, local binding, SOCKS, and unrestricted
Unix-socket access are disabled. `approvalPolicy: on-request` lets Codex request
approval when needed; `approvalsReviewer: user` selects the user as reviewer.

These permissions apply to sandboxed Codex tools. Required model calls and
gateway/app-server control traffic are separate. Hosted cached search uses the
model service; it does not require granting tool access to search-result sites.
The template sets `tools.web.search.openaiCodex.mode: cached` and disables
browser and web-fetch alternatives. Keep the restricted permission profile:
Codex can promote a cached preference to live search under unrestricted
permissions.

OCE stores native Configuration values; it does not validate every installed
plugin option or attest that the running app-server applied this policy.
Installation requirements, runtime versions, later draft edits, and per-session
overrides can affect the effective policy. A Preset is an editable copy and is
not an administrator-enforced ceiling.

Kubernetes currently adds public TCP/443 egress to the dedicated Codex Pod for
model transport. That exception is wider than model-only traffic and also
applies to processes outside the native sandbox. Its namespace default-deny
NetworkPolicy does **not** remove that grant. Docker networking likewise does
not turn this template into a domain firewall. Strict Pod-wide deny-by-default
egress requires an independently enforced model/control transport policy; the
smallest backend follow-up is replacing the existing broad model-egress grant
with an approved model proxy and exact peer/port rules. This Preset does not
implement that backend change.

To allow a destination, explicitly add its hostname with value `allow` to
`plugins.entries.codex.config.appServer.networkProxy.domains` in the copied
Configuration and redeploy. Keep grants narrow, review the change, and repeat
the checks below. Do not copy a host's general network allowlist.

## Verify before use

On your selected runtime, verify all of these through a fresh gateway session:

1. Read effective app-server thread configuration: the named permission profile
   contains only the listed build hosts, the approval policy is `on-request`, and search is cached.
   Inspect the rendered runtime configuration as well as the saved draft.
2. Execute a tool request to a listed package host, then to a known reachable,
   operator-controlled hostname outside the allowlist. Confirm success for the
   listed host and native proxy denial for the unlisted host. Attempt direct-IP/proxy-bypass access from
   the same sandbox. A timeout alone does not establish policy enforcement.
3. Confirm a normal model turn and cached hosted-search result succeed while
   direct web fetch and browser access remain unavailable.
4. In an isolated test copy, allow one controlled hostname and verify that it
   succeeds while another stays denied. Inspect gateway and Harness separately;
   keep credentials out of logs and the gateway.

If the runtime rejects or ignores the network/search fields, stop deployment
and select compatible images. Do not switch to danger-full-access or live
search to make it work. A sandbox startup failure requires fixing the runtime
or seccomp prerequisites.

[Preset integration coverage](../../testing/local.md#standard-codex-preset)
checks installation and draft creation. It does not substitute for the native
enforcement and model checks above.
