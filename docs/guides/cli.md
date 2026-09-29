# Set up the OCC CLI

<a id="occ-cli"></a>

Use `occ` to manage OpenClaw Control Plane (OCC) resources from a terminal. You
need your Installation's OCC endpoint and a protected service-key response file.
For all commands and flags, see the [CLI command reference](../reference/cli.md).
To deploy through the browser, see [Create and deploy Agents in the console](../reference/console/create-and-deploy.md).

## Connect to your Installation

For a published OCE version, download the binary matching your machine from
the [GitHub Releases page](https://github.com/openclaw/openclaw-enterprise/releases).
The assets are named `occ-v<version>-<os>-<arch>` for macOS (`darwin`) and Linux,
on `amd64` or `arm64`. Download `SHA256SUMS` from the same release and compare
the selected binary's SHA-256 before making it executable. Private repository
downloads require GitHub access. For example, with the GitHub CLI:

```bash
export OCE_VERSION='v<release-version>'
export OCC_ASSET="occ-${OCE_VERSION}-darwin-arm64" # Choose your OS and CPU.
gh release download "$OCE_VERSION" \
  --repo openclaw/openclaw-enterprise \
  --pattern "$OCC_ASSET" --pattern SHA256SUMS
expected="$(awk -v name="$OCC_ASSET" '$2 == name { print $1 }' SHA256SUMS)"
actual="$(shasum -a 256 "$OCC_ASSET" | awk '{ print $1 }')"
if [ -n "$expected" ] && [ "$actual" = "$expected" ]; then
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$OCC_ASSET" "$HOME/.local/bin/occ"
  "$HOME/.local/bin/occ" --version
else
  printf 'OCC CLI checksum verification failed; binary not installed.\n' >&2
fi
```

Ensure `$HOME/.local/bin` is on `PATH`. On Linux, use
`sha256sum "$OCC_ASSET"` in place of `shasum -a 256` if `shasum` is not
installed. The printed CLI version should match the selected release.

To build from a trusted source checkout instead, run this from its root to
install `occ` on your Go binary path:

```bash
go install ./cmd/occ
```

Ensure that directory is on `PATH`. To use the binary inside the checkout
instead, run `pnpm cli:build` and substitute `./bin/occ` for `occ` below.
`occ dev up` and `occ dev down` still require a source checkout even when the
binary came from a GitHub Release.

Set the endpoint and the service-key file supplied by your administrator or
created during [bootstrap](../reference/authentication/service-api-keys.md#retrieve-the-bootstrap-service-key):

```bash
export OCC_URL='https://occ.example.com'
export OCC_SERVICE_KEY_FILE='/private/path/occ-service-key.json'
occ installation get
occ namespace list
```

Replace both example values with your own. These commands require an
Installation-scoped key; reading the Installation also requires Installation
`read`. If your key is Namespace-scoped, use
`occ namespace get '<namespace-id>'` with the ID supplied by your administrator
instead.

`installation get` prints the Installation ID and name. `namespace list` prints
the authorized Namespaces and their `STATUS`; a Namespace must be `ready` to
deploy an Agent. Add `--output json` or `--output yaml` to print the resource or
list without the HTTP response envelope. Set a Namespace once for subsequent
commands:

```bash
export OCC_NAMESPACE='<namespace-id>'
```

## Choose your next task

<a id="create-an-agent-draft"></a>
<a id="deploy-and-check-an-agent"></a>
<a id="provision-integration-secrets"></a>
<a id="manage-namespace-iam"></a>
<a id="manage-local-development"></a>

| Task                                    | Guide                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create and deploy an Agent              | [Production Agent deployment](deploy/production-agents.md), including Configuration, model credentials, and verification                                           |
| Update a Configuration and deploy again | [Agent revisions](topics/agent-revisions.md); its CLI examples also require `jq`                                                                                   |
| Stop or delete an Agent                 | [Agent lifecycle](topics/agent.md#how-an-agent-runs) and [deletion and cleanup](../reference/agents.md#deletion)                                                   |
| Create or replace integration Secrets   | [Namespace Secrets](../reference/drivers/kubernetes-secret.md#create-a-namespace-owned-secret) and [Configuration bindings](../reference/configuration/secrets.md) |
| Use a Credential Gateway                | [Credential sources](../reference/credential-sources.md), including the current OpenShell limits                                                                   |
| Grant access to a Namespace resource    | [Namespace IAM](../reference/authorization.md#manage-namespace-policy)                                                                                             |
| Inspect or upgrade the running fleet    | [Production image upgrades](deploy/production-upgrade.md) and the [CLI reference](../reference/cli.md)                                                             |
| Run a local development installation    | [Local Setup](quickstart.md)                                                                                                                                       |

## Connection and credential boundaries

The key file is the full JSON response from bootstrap or key issuance, not a
file containing only the raw key. Keep it owner-readable; never put the key in
command arguments, logs, or source control. For HTTPS signed by a private
certificate authority, set `OCC_CA_BUNDLE` to its PEM bundle. See
[global options](../reference/cli.md#global-options) for timeout, origin, and
TLS behavior.

## Troubleshoot

- `invalid service-key file`: Check that the JSON contains a nonempty
  `data.key` with no line break.
- HTTP `401`: OCC rejected the credential; retrieve or issue the intended key.
- HTTP `403`: Ask your administrator to check the service principal's permission
  for the exact operation and Namespace.
- Certificate error: Set `OCC_CA_BUNDLE` to the correct PEM bundle. The CLI has
  no insecure TLS mode.
