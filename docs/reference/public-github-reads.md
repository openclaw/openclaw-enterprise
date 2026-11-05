# Read known public GitHub repositories

Dedicated Codex Agents can clone and fetch public GitHub repositories with ordinary
HTTPS GitHub URLs, and read repository metadata, issues, pull requests, releases
and small source files. The reader authenticates each Agent revision, then sends
anonymous HTTPS requests to GitHub. Public reads need no GitHub App, repository
binding or GitHub token. Use [managed repository credentials](repository-credentials.md)
for private access and contributions. Bound repositories keep that authenticated
path when public reads are also selected.

## Enable the reader

The reader is off by default. Enable it after OCC bootstrap, so you can supply the
actual Installation ID from `occ installation get`. In the `codex`
[Installation profile](../guides/deploy/installation-profiles.md) input, add:

```json
{
  "publicGithubRead": {
    "enabled": true,
    "clusterIP": "10.43.0.19",
    "installationId": "ins_REPLACE_WITH_EXISTING_INSTALLATION_ID",
    "authorizationConfigMapName": "public-github-authorizations",
    "tlsSecretName": "public-github-reader-tls",
    "caBundleFile": "./public-reader-ca.pem",
    "policy": {
      "mode": "repositories",
      "repositories": ["openclaw/openclaw"]
    },
    "upstreamCidrs": ["REPLACE_WITH_APPROVED_IPV4_CIDRS"]
  }
}
```

Reserve `clusterIP` in the cluster's Service range. Use approved IPv4 CIDRs for
**both `github.com` Git traffic and `api.github.com` API traffic**. Use an enforcing
NetworkPolicy implementation. The profile produces matching Helm values and
`drivers.compute.configuration.network.publicGithubRead` peer and trust settings.
The actual Installation ID is an operator input for the Helm registry owner label;
the renderer omits it from `installation.yaml`. OCC supplies its runtime identity
at Agent admission, and Compute freezes it in the service descriptor. Startup
YAML rejects Installation IDs at any depth. The renderer
reads `caBundleFile` relative to the input file; it accepts public PEM certificates
up to 65 KiB and refuses private keys. It does not read a TLS private key.

Create the dedicated `tlsSecretName` Secret in the Helm release namespace with
`tls.crt` and `tls.key` before enabling the Deployment. The certificate must have
an **IP subject alternative name for the reserved ClusterIP**, because clients
verify `https://CLUSTER_IP:8080`. Use your approved issuer or cert-manager with
that IP in `ipAddresses`. A certificate issued only for Service DNS names does
not satisfy this check. In particular, an OpenShift service-CA certificate for
Service DNS names is insufficient for the IP endpoint. Do not reuse a GitHub App,
provider credential, database, or authentication Secret for reader TLS.

The chart serves HTTPS on port 8080, mounts only the dedicated leaf certificate
and key plus public policy and authorization ConfigMaps, and gives the reader
no service-account token. It creates a public trust ConfigMap named
`openclaw-enterprise-public-github-read-ca`; Compute also receives the same public
PEM in `caBundle` for runtime projection. No App key or GitHub token belongs in
reader configuration. Restart the reader after replacing its leaf certificate
and restart supervisors after changing their trust bundle; both load TLS material
at startup.

### Trust the reader in OpenShell

Configure trust in both the native Git client in the Harness and the OpenShell
supervisor's outbound TLS verifier. Compute projects Harness trust; the separate
OpenShell installation owns supervisor trust. Its native certificate loader in
`openshell-supervisor-network/src/l7/tls.rs` reads system roots and
`SSL_CERT_FILE` at startup.

Stock OpenShell v0.1.6's Kubernetes Driver has no general supervisor environment
or volume override. Use a qualified supervisor image with the reader issuer added
to its system trust, or operator-managed admission injection that mounts a PEM
bundle and sets `SSL_CERT_FILE` before the supervisor starts. Retain public roots
needed by other destinations. Adding a CA layer does not require changing the
OpenShell binary, but the resulting image still needs deployment qualification.
The OCE chart does not install this trust or an admission injector.

An application CA file alone does not configure the supervisor. Verify a public
clone through the deployed protected Agent, with certificate verification enabled,
before treating this setup as qualified. The chart admits supervisor Pods labeled
`openshell.ai/boundary-role: supervisor` in managed namespaces without requiring
OCE workload labels. Compute grants egress to the exact selected supervisor;
protected workload Pods receive no direct reader grant. Ordinary selected Harness
Pods retain their own reader egress.

## Select repository scope

The Installation `policy` is a ceiling. `{ "mode": "all" }` permits any currently
public repository; `{ "mode": "repositories", "repositories": ["owner/repository"] }`
permits a list of at most 256 names. Names are case-insensitive and become
lowercase canonical `owner/repository` identities. An omitted Installation policy
or an empty list denies every repository.

Select public reads separately in a dedicated Agent's Configuration or Preset:

```json
{
  "plugins": {
    "entries": {
      "codex": {
        "config": {
          "publicGithubRead": {
            "mode": "repositories",
            "repositories": ["openclaw/openclaw"]
          }
        }
      }
    }
  }
}
```

Deploy a new Agent revision after changing its selection. Omission and empty
lists grant no public reads. Effective scope is the intersection of the current
Installation ceiling and the selection saved for that revision. Native network
denies remain narrowing constraints. Enabling the reader grants no Agent access
by itself, and an existing revision does not inherit a later selection.

The supported packaging is single-cluster Kubernetes and dedicated Codex. The
paired OpenShell Sandbox and Credential Proxy can admit this additional service
alongside protected repository access. See
[OpenShell qualification](../testing/openshell.md) for the current runtime proof
and production limits.

## Preserve authorization during updates

Create the mutable `authorizationConfigMapName` ConfigMap once in the reader
namespace, before enabling the Deployment. Set `data.authorizations.json` to
`"{}\n"` and label `openclaw.dev/public-read-installation` with the first 32
hexadecimal digits of SHA-256 of the actual Installation ID. Keep this resource
outside Helm and any continuously applied installation manifest. Compute owns
its contents after initialization; chart upgrades do not render or overwrite it.
A live Helm render checks the ownership label when the ConfigMap exists.
Never clear, regenerate or restore an older copy during an image update: that
could restore a withdrawn grant. A missing or incorrectly owned registry prevents
Compute from authorizing reads.

Create it before starting the reader, using the names from your profile inputs:

```sh
kubectl -n RELEASE_NAMESPACE create configmap AUTHORIZATION_CONFIGMAP \
  --from-literal='authorizations.json={}'
kubectl -n RELEASE_NAMESPACE label configmap AUTHORIZATION_CONFIGMAP \
  openclaw.dev/public-read-installation=INSTALLATION_ID_SHA256_FIRST_32_HEX
```

Compute the label from the exact Installation ID bytes, without a trailing newline.
These commands initialize a new registry; do not run them as an update procedure.

The API and worker can read and replace only the named registry through its
Role. Compute publishes capability hashes, revision identities, scope and a
10-minute lease, refreshed every 30 seconds. The reader reads the projected file
afresh; an unreadable or expired authorization denies reads. The revision's
capability stays in its owned Secret and is never sent to GitHub. The registry
has a 1 MiB limit, including retained withdrawal records; Compute refuses additions
at that limit. Automatic collection of retired records is not implemented. API and Git
requests both authenticate before provider reads or sharing an in-flight result.

Keep the Service address, TLS trust, registry and Compute peer until selected
revisions have retired. Withdraw selections and deploy successors before removing
them. Withdrawal expires the authorization and stops the owner-provisioned
Harness, then waits for the reader to acknowledge that revision's authorization
digest. Registry or reader failure leaves withdrawal pending and does not prevent
Compute from attempting runtime shutdown. Do not treat removing a NetworkPolicy alone as
proof that existing connections closed, or disable the reader before that proof.

## Use and troubleshoot

Use ordinary `https://github.com/OWNER/REPOSITORY.git` clone and fetch URLs.
Stored remotes stay unchanged. The managed transport delegates bound repositories
to their authenticated path and does not fall back to direct access after a reader
denial. The public path supports clone and fetch; SSH and LFS are unsupported.
The reader refuses writes, redirects and arbitrary destinations. Public reader
challenges cannot invoke Git askpass; bound repositories retain their authenticated
credential path.
Git transfers allow a 4 MiB encoded request body, a 1 GiB response and a 10-minute
deadline. Cancellation, incomplete transfers and limits fail the Git operation.

The `public-github-read` skill also reads paths under `/repos/{owner}/{repository}`:
repository metadata, `pulls`, `issues` and `releases` lists and numeric details,
and `contents/{path}`. Files up to 1 MiB return inline base64. Path components
contain 1–100 ASCII letters, digits, periods, underscores or hyphens, excluding
`.` and `..`. Directories at GitHub's 1000-entry limit are reported as possibly
incomplete. Relative pagination links preserve supported filters and cursors;
unrepresentable links or pages beyond 1000 report an incomplete listing.

Use the skill's managed GET command for API reads:

```sh
node "$GIT_EXEC_PATH/transport.mjs" --api-get '/repos/OWNER/REPOSITORY/contents'
```

For lists, use `--api-get-metadata` with the same relative route. On success it
returns JSON `{status, link, body}`: `status` is the HTTP status, `link` is the
reader's relative pagination Link or `null`, and `body` is the decoded JSON.
Follow the target with `rel="next"` through this same mode until no next relation
remains. A failed command or an unfinished next link means the listing is
incomplete. Body-only `--api-get` does not expose pagination.

The HTTP parser limits each header block to 16 KiB. The helper also limits
aggregate parsed informational/final headers to 16 KiB, counting canonical status
lines and separators; original wire whitespace is not retained. Metadata mode
limits Link to 8 KiB and rejects malformed, duplicate or cross-resource
links; each relative target retains the 2048-character route limit. Other headers
are discarded. Non-success, invalid JSON or invalid metadata emits no success
envelope or body. Neither mode automatically paginates or follows redirects.

Native Codex smart-HTTP Git needs POST for upload-pack. An authored
`appServer.networkProxy.mode: limited` permits API GET but blocks this Git step;
OCE does not silently relax that narrowing constraint. A native proxy configured
for Git must permit full HTTP methods while retaining its explicit reader-host
allow and filesystem/exec sandbox. Keep local binding and unused SOCKS disabled.
Host domains do not constrain URL paths or ports: the selected service policy and
reader enforce those boundaries, including receive-pack refusal. Full-mode HTTPS
tunnels do not qualify the limited-mode interception TLS path. Protected OpenShell
uses its existing profile and exact service/port/L7 rules instead of this nested
native proxy.

Synchronous managed-helper refusals include a fixed `public-git-refusal` phase
and allowlisted error code (or `unknown`). These identify configuration,
authorization, trust reading/composition, private trust-file creation or child
setup/dispatch without exposing paths, values or exception text. They preserve
the failed operation and exit status; they are not a retry or diagnosis of an
unobserved cause.

The helper fixes the reader origin, authorization and proxy route. It combines
reader trust with the current tool CA files for every Git/API operation. Do not
replace this with a static curl CA selection: it can omit Codex's later
interception CA. Selected CA files must contain public PEM certificates, with
optional hash comments or underlined certificate labels, and be at most 1 MiB
each. Combined input is limited to 4 MiB; the deduplicated bundle to 1 MiB.
Missing, malformed or oversized trust fails before contact.

Git operations create a unique private directory in the existing runtime
workspace selected by `OPENCLAW_WORKSPACE_DIR`. This works within the native
workspace write grant even when `/tmp` is absent. The helper does not use its
current directory, which Git may move into `.git`. A selected workspace must be
absolute and writable; failure stops the operation without retrying elsewhere.
Standalone callers without that runtime variable retain the host temporary root.

Only public CA certificates enter these transient workspace files: directory
mode is `0700`, bundle mode is `0400`, and the capability stays in memory and
the child environment/input. Completion, failure and handled cancellation remove
that operation's directory. Uncatchable termination can leave a public-CA
residue in the workspace; the helper does not scavenge other operations' files.
It does not change Git configuration or index state.

API reads use the same validated current trust entirely in memory on every
supported host. A fixed child of the existing Node executable receives request
data, capability and CA bytes on bounded stdin. It uses Node's built-in HTTPS
Agent and proxy support; no workspace, temporary file or descriptor pathname is
needed. The child environment contains only the fixed executable search path
`/usr/local/bin:/usr/bin:/bin`; inherited PATH, Node debugging, preload, insecure-TLS
and key-log settings do not enter it. This also supports the pinned image when
Node reports a bare executable name because proc is unavailable. Origin TLS uses only the
composed tool roots. HTTPS proxy TLS uses those roots plus the selected Node
defaults and operating-system roots, configured only in that child before any connection.

The pinned Node runtime supports direct, HTTP-proxy and HTTPS-proxy reads with
hostname verification. Proxy selection preserves lowercase/uppercase HTTPS then
ALL_PROXY precedence; an explicitly empty selection means direct. Invalid or
unsupported proxy schemes fail before contact, and ambient NO_PROXY cannot
bypass a selected proxy. HTTPS proxies requiring SNI are not qualified by Node's
built-in connector; failure never selects a different transport. Custom Node
builds using an unenumerated OpenSSL default CA store are not qualified.

The API's 24-second parent deadline covers startup, DNS, proxy establishment, TLS
and response transfer. Cancellation kills the child and its pending connections;
no API files remain after termination. Read-only native and protected runtime
qualification remain separate; see [verification](../testing/repository-credentials.md).

The launcher also supplies reader trust through `CODEX_CA_CERTIFICATE` before
Codex starts so its proxy can verify the upstream reader. This affects only the
selected process, but its upstream root store is shared across allowed
destinations, not cryptographically restricted to one origin. Exact endpoint
selection, destination policy and hostname verification still apply. System
trust and the separate OpenShell supervisor trust procedure are unchanged.

A `401` indicates an absent, invalid or expired capability; a scope denial is
`403`. A `404` can mean missing or private. GitHub visibility is checked for each
read. Anonymous quota is shared at the egress IP. `429` gives a retry delay; a busy
reader returns `503`. Concurrency limits apply service-wide and per observed
caller address, which can be a shared supervisor address. They do not establish
per-Agent or per-tenant fairness. API reads have a 24-second deadline and a 12 MiB
response limit. Only simultaneous identical reads share a result; completed
results are not cached. A failed or incomplete listing does not prove zero matches.

For TLS failures, verify the certificate's IP SAN and issuer at both trust points.
For authorization failures after restart or upgrade, verify the registry's
Installation label and projected `authorizations.json` without printing capabilities.
See the [Agent read flow](../flows/public-github-reads.md) for runtime ownership.
