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
the selected binary's SHA-256 before making it executable. For example, with
the GitHub CLI:

```bash
(
  set -eu
  OCE_VERSION='v<release-version>'
  OCC_ASSET="occ-${OCE_VERSION}-darwin-arm64" # Choose your OS and CPU.
  umask 077
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/occ-install.XXXXXXXX")"
  trap 'rm -rf "$tmp_dir"' EXIT

  gh release download "$OCE_VERSION" \
    --repo openclaw/openclaw-enterprise --dir "$tmp_dir" \
    --pattern "$OCC_ASSET" --pattern SHA256SUMS
  cd "$tmp_dir"

  # Compare the full checksum line (digest and filename) for this asset.
  expected="$(awk -v name="$OCC_ASSET" '$2 == name' SHA256SUMS)"
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$OCC_ASSET")"
  else
    actual="$(sha256sum "$OCC_ASSET")"
  fi
  if [ "$actual" != "$expected" ]; then
    printf 'OCC CLI checksum verification failed; binary not installed.\n' >&2
    exit 1
  fi
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$OCC_ASSET" "$HOME/.local/bin/occ"
  "$HOME/.local/bin/occ" --version
)
```

Ensure `$HOME/.local/bin` is on `PATH`. The example uses `shasum` if available
and otherwise uses `sha256sum`. The printed CLI version should match the
selected release. Use the release your controller runs, and upgrade `occ`
with it: an older `occ` can misread newer API responses, such as paged Agent
revision lists.

To build from a trusted source checkout instead, run this from its root to
install `occ` on your Go binary path:

```bash
go install ./cmd/occ
```

Ensure that directory is on `PATH`. To use the binary inside the checkout
instead, use the Go version in `go.mod`, run
`go build -trimpath -o bin/occ ./cmd/occ` from the repository root, and substitute
`./bin/occ` for `occ` below. Building the CLI does not require Node.js, pnpm, or
installed JavaScript dependencies.
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

`occ` has no human sign-in: a service key authenticates a non-Agent
ServicePrincipal, not a person. Without a key, use the
[console](../reference/console.md).

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

## Give a member or automation CLI access

People sign in to the console; the CLI authenticates only with a service key.
An Installation administrator gives someone CLI access to one Namespace by
issuing a key for a Namespace service principal that holds only the grants
you bind. With an administrator key file and `OCC_NAMESPACE` set:

```bash
occ iam service-principal create -o json    # note its id: <service-principal-id>
occ iam access-binding create --file binding.json
occ service-key create --service-principal '<service-principal-id>' \
  --name nora-laptop --expires-in-days 30 --out nora-key.json
```

`binding.json` names the service principal as `subjectId` and an existing
Namespace Role; see [Namespace IAM](../reference/authorization.md#manage-namespace-policy).
Each binding grants one target, so bind the same targets a person would need, as in
[Let a person run an existing Agent](topics/iam.md#let-a-person-run-an-existing-agent).
Issuing the key requires that you already hold every grant of the service
principal. The key never reaches another Namespace, IAM policy, or key issuance. Hand over the `0600` key file privately; the member
sets `OCC_SERVICE_KEY_FILE` to it and `OCC_NAMESPACE` to the Namespace. When the
key is no longer needed, run `occ service-key revoke <key-id>` (the ID printed
at creation) or delete its AccessBindings. Disabling the member's console
account does not end the key, so revoke it when they leave. OCE does not record
whom a key was issued for, so start each key's `--name` with the person's name, as
`nora-laptop` does: [Remove a person](topics/iam.md#remove-a-person) finds their keys by it.

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
| Let an Agent use a Secret               | [Grant the Agent's own identity Secret `operate`](topics/iam.md#let-an-agent-use-a-secret)                                                                         |
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

- `service-key file … has no data.key` (or `is not JSON`): use the complete JSON
  file from `occ service-key create`, with a nonempty `data.key` on one line.
- `OCC rejected the service key`: the key is invalid, expired or revoked. Ask an
  Installation administrator for a new key.
- HTTP `403`: the message names the missing grant. Ask an Installation
  administrator to grant it.
- `certificate is not trusted`: set `OCC_CA_BUNDLE` to your Installation's PEM
  bundle. The CLI has no insecure TLS mode.
