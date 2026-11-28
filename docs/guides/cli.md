# Set up the OCC CLI

<a id="occ-cli"></a>

Use `occ` to manage OpenClaw Control Plane (OCC) resources from a terminal. Commands
that access the OCC API need your Installation's endpoint and a protected
service-key response file. To inspect an initialization Job without the OCC API,
see [Resume an installation in progress](deploy/production-handoff.md#resume-an-installation-in-progress).
For all commands and flags, see the [CLI command reference](../reference/cli.md).
To deploy through the browser, see [Create and deploy Agents in the console](../reference/console/create-and-deploy.md).

## Connect to your Installation

Choose the release tag `v<version>` that matches your controller, then download
the binary for your machine from the public
[GitHub Releases page](https://github.com/openclaw/openclaw-enterprise/releases).
You can download the binary and checksum file in a browser without signing in.
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
selected release. Upgrade `occ` with the controller: an older `occ` can misread newer API responses, such as paged Agent
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

For a new production Installation, [authenticate in the original shell](#authenticate-after-a-production-install)
and skip the example below. Otherwise, set the endpoint and the service-key
file supplied by your administrator or created during [bootstrap](../reference/authentication/service-api-keys.md#retrieve-the-bootstrap-service-key):

```bash
export OCC_URL='https://occ.example.com'
export OCC_SERVICE_KEY_FILE='/private/path/occ-service-key.json'
occ installation get
occ namespace list
```

`occ` has no human sign-in: a service key authenticates a non-Agent
ServicePrincipal, not a person. For OCC API access without a key, use the
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

People sign in to the console; the CLI authenticates to the OCC API with a service key.
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
sets `OCC_SERVICE_KEY_FILE` to it and `OCC_NAMESPACE` to the Namespace. If issuance fails, keep any output private and follow
[key recovery](../reference/authentication/service-api-keys.md#recover-a-lost-or-exposed-service-key).

When the key is no longer needed, run `occ service-key revoke <key-id>`
with the ID printed at creation. Revocation requires the same authority as
issuance, checked against the principal's current grants. Removing bindings
does not revoke the key. Restoring grants can restore its access. Disabling
the member's console account also leaves the key in place. Revoke it when
they leave. OCE does not record
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
| Enroll a managed credential             | [Credential Sources](../reference/credential-sources.md), including TokenService, Credential Proxy and cutover status                                              |
| Grant access to a Namespace resource    | [Namespace IAM](../reference/authorization.md#manage-namespace-policy)                                                                                             |
| Let an Agent use a Secret               | [Grant the Agent's own identity Secret `operate`](topics/iam.md#let-an-agent-use-a-secret)                                                                         |
| Inspect or upgrade the running fleet    | [Production image upgrades](deploy/production-upgrade.md) and the [CLI reference](../reference/cli.md)                                                             |
| Run a local development installation    | [Local Setup](quickstart.md)                                                                                                                                       |

## Connection and credential boundaries

The key file is JSON containing `data.key`, either prepared locally for
[bootstrap](../reference/authentication/service-api-keys.md#retrieve-the-bootstrap-service-key)
or saved from key issuance, not a
file containing only the raw key. Keep it owner-readable; never put the key in
command arguments, logs, or source control. For HTTPS signed by a private
certificate authority, set `OCC_CA_BUNDLE` to its PEM bundle. See
[global options](../reference/cli.md#global-options) for timeout, origin, and
TLS behavior.

## Authenticate after a production install

Use this procedure after a [confirmed Kubernetes installation](deploy/production-installation.md#authenticate-to-the-production-api).

In the original Installation shell, set `OCC_URL` to the trusted production
HTTPS endpoint for this cluster. For generated inputs, use the original
receipt and state directories. The checks below match the release and
namespace in the linked installation guide. For a custom install, substitute your reviewed target values.
A nonempty `OCC_BOOTSTRAP_KEY_FILE` skips receipt lookup. Use it only for a
prepared file you have verified belongs to this Installation.

Keep `OCC_SERVICE_KEY_DIRECTORY` and `OCC_SERVICE_KEY_FILE` set until
you finish an existing session. Don't run the copy example again.
If `OCC_SERVICE_KEY_FILE` already selects a supplied file for this Installation,
keep it selected and skip the copy and its cleanup. Authenticate directly.
Stop on failure.

```bash
[[ ${OCC_URL:-} == https://?* && -n ${OCC_SERVICE_KEY_FILE:-} ]] &&
  OCC_URL="$OCC_URL" OCC_SERVICE_KEY_FILE="$OCC_SERVICE_KEY_FILE" occ installation get &&
  export OCC_URL OCC_SERVICE_KEY_FILE &&
  printf '%s\n' 'Supplied file authenticated.'
```

Otherwise, prepare a session copy. For generated inputs, choose the
kubeconfig and context independently of the receipt. Verify that both the
Kubernetes connection and `OCC_URL` belong to your intended Installation.
Keep the protected inputs unchanged through authentication. The read-only
[installation plan](deploy/production-handoff.md#resume-an-installation-in-progress)
checks the cluster against the receipt. If it fails, follow the handoff
before continuing. A complete Job alone cannot confirm Helm or API readiness.

```bash
umask 077
prepare_occ_service_key() {
  local source="${OCC_BOOTSTRAP_KEY_FILE:-}" inputs state directory file
  if [[ -n ${OCC_SERVICE_KEY_FILE:-} || -n ${OCC_SERVICE_KEY_DIRECTORY:-} ]]; then
    printf '%s\n' 'A key file or directory is already selected. Preserve it.' >&2
    return 1
  fi
  if [[ ${OCC_URL:-} != https://?* ]]; then
    printf '%s\n' 'Set OCC_URL to the trusted production HTTPS endpoint.' >&2
    return 1
  fi
  if [[ -z "$source" ]]; then
    state="${XDG_STATE_HOME:-${HOME:+$HOME/.local/state}}"
    if [[ -z ${OCC_INPUT_DIRECTORY:-} ||
          ${INSTALL_RECEIPT_DIRECTORY:-} != "$OCC_INPUT_DIRECTORY/install-receipt" ||
          $state != /* ]]; then
      printf '%s\n' 'Restore the original input, receipt and state directory settings.' >&2
      return 1
    fi
    state="$(cd -L -- "$state" && pwd -L)" || return 1
    if ! inputs="$(jq -ers --arg root "${state%/}" \
      --slurpfile intent "$INSTALL_RECEIPT_DIRECTORY/intent.json" '
        select(length == 1 and ($intent | length) == 1)
        | $intent[0] as $i
        | select(($i | keys) == ["attempt", "chartSha256", "clusterSha256",
            "createdAt", "namespace", "operation", "release", "valuesSha256", "version"])
        | select($i.version == 1 and $i.operation == "helm-install")
        | select($i.release == "oce" and $i.namespace == "openclaw-system")
        | select($i.attempt | test("^[0-9a-f]{64}$") and length == 64)
        | .[0].inputDirectory
        | select(. == ($root + "/occ/installation-credentials/" + $i.attempt))
      ' "$INSTALL_RECEIPT_DIRECTORY/bootstrap-secret.json" 2>/dev/null)"; then
      printf '%s\n' 'Receipt and generated key source must match the original install.' >&2
      return 1
    fi
    occ installation plan --kubeconfig "${KUBECONFIG_FILE:-}" --context "${CONTEXT:-}" \
      --kube-namespace openclaw-system --release oce \
      --receipt "$INSTALL_RECEIPT_DIRECTORY" || return 1
    source="$inputs/bootstrap-client-key.json"
  fi
  if [[ ! -f "$source" || ! -r "$source" ]]; then
    printf '%s\n' 'Check the retained source file.' >&2
    return 1
  fi
  directory="$(mktemp -d /tmp/occ-service-key.XXXXXXXX)" || return 1
  file="$directory/occ-service-key.json"
  if ! install -m 600 -- "$source" "$file" ||
     ! OCC_URL="$OCC_URL" OCC_SERVICE_KEY_FILE="$file" occ installation get; then
    if ! rm -f -- "$file" || ! rmdir -- "$directory"; then
      printf 'Check the session copy in %s before retrying.\n' "$directory" >&2
    fi
    return 1
  fi
  export OCC_URL OCC_BOOTSTRAP_KEY_FILE="$source"
  export OCC_SERVICE_KEY_DIRECTORY="$directory" OCC_SERVICE_KEY_FILE="$file"
}
prepare_occ_service_key && printf '%s\n' 'Session copy authenticated.'
```

After a successful response, [record the Installation ID and continue setup](deploy/production-installation.md#authenticate-to-the-production-api).
When the session ends, [remove only the copy created here](deploy/production-agents.md#end-the-operator-session).
Keep the protected source.

## Troubleshoot

- `service-key file … has no data.key` (or `is not JSON`): use the complete JSON
  file from `occ service-key create`, with a nonempty `data.key` on one line.
- `OCC rejected the service key`: the key is invalid, expired or revoked. Ask an
  Installation administrator for a new key.
- HTTP `403`: check the caller's identity, scope, grants and Restrictions.
  To issue or revoke a key, also check coverage of the target principal's grants.
- `certificate is not trusted`: set `OCC_CA_BUNDLE` to your Installation's PEM
  bundle. The CLI has no insecure TLS mode.
