# Strands Box known gaps

What an operator deploying this example today must know. Each entry names
what you see, why, what to do now, and where the fix stands upstream. New
entries use the same four fields.

## Upstream TLS trusts only Box's built-in public roots

- **Symptom:** the first model request from Box fails its upstream TLS
  handshake when the controlled inference endpoint uses a private IPv4
  address, a `.svc.cluster.local` name, or a certificate from a private CA.
- **Cause:** Strands Box v0.2.2 verifies every upstream certificate against
  public roots compiled into it. Its configuration file has no setting that
  adds another CA.
- **Workaround:** name the endpoint with an operator DNS name pinned to one
  private IPv4 address, then either use a publicly trusted certificate for that
  name, or use a Box build that reads the `upstream-ca-file` key and set the
  host's upstream CA bundle. Box trusts that bundle for every upstream it dials,
  so the host refuses to start unless every route Box dials declares the
  bundle's digest. An inline workspace node must opt in or use the separate file
  node. See [Controlled inference route](driver/README.md#controlled-inference-route).
- **Upstream status:** reported as
  [strands-agents/box#54](https://github.com/strands-agents/box/issues/54).
  [strands-agents/box#147](https://github.com/strands-agents/box/pull/147) is open
  and adds the gateway-wide `upstream-ca-file` key that the host writes. Per-route
  CA scoping upstream would remove the need for every route to opt in.

## Box presents no client certificate

- **Symptom:** a TLS client certificate configured inside Box (for example
  `git -c http.sslCert` or `curl --cert`) never reaches the server. A server that
  identifies the caller by its certificate refuses every request from Box.
- **Cause:** Box intercepts every `CONNECT` and builds both TLS legs without
  client authentication.
- **Workaround:** none for mutual TLS. The paired registration identifies the
  execution by a per-execution bearer whose digest the host reports, together
  with the host control process, as the committed recipient.
- **Upstream status:** not yet reported to strands-agents/box.

## GitHub access through Box (Stage A prototype)

- **Symptom:** the paired registration gives stock `git` and `gh` GitHub access,
  but OCE neither authorizes nor records individual requests. Any branch, base,
  number of draft pull requests or API call the installation token permits
  succeeds. `occ.credential_deliveries` records the install, but no request
  exchange or draft receipt rows exist for the execution.
- **Cause:** Box v0.2.2 has no request-phase hook that asks an external service
  before it attaches a credential. Its `EffectInterceptor` is internal and sees
  only method, path and body length. The host therefore delivers the installation
  token to `box run`, and Box sends with it on its own. The Credential Proxy
  contract permits material reads for receipt or installation only, not as
  authorization to send, so this stage cannot land.
- **Workaround:** use only on a dogfood host with a test repository. Keep
  branch protection on the base branch. Grant the App only Contents, Pull
  requests and Metadata on the selected repository.
- **Upstream status:** a Box fork adds an `authorizer://` credential source
  that asks an operator endpoint for each request and fails closed. Drafts for
  strands-agents/box go to the owner first; nothing is filed yet.

## Box reads env:// credentials once at start

- **Symptom:** the Box host restarts the released `box run` once, right after
  the revision activates, and Codex restarts with it. About an hour after the
  token was minted, or as soon as OCE renews it, the execution's GitHub requests
  fail with `401` until the Agent is redeployed.
- **Cause:** OCE prepares installation tokens only for the Agent's active
  revision, and activation needs the Harness serving, so the token cannot exist
  before Box starts. Box v0.2.2 reads each `env://` secret once at start and has
  no refreshable source. OCE's renewal retires, and revokes, the token Box holds.
- **Workaround:** redeploy the Agent after access ends. The restart happens
  before the revision serves traffic, and the Compute install check waits for
  the node to reconnect after it.
- **Upstream status:** the same fork's `authorizer://` source returns a fresh
  credential per request. Not yet reported to strands-agents/box.

## A phantom credential cannot carry Git's first request

- **Symptom:** with a `phantom` route on `github.com`, every stock Git request
  fails with `403`.
- **Cause:** Git sends its first smart-HTTP request without a credential and
  waits for a `401` challenge. A phantom route refuses a request to its
  destination that lacks the placeholder. `http.proactiveAuth` needs Git 2.46
  or later.
- **Workaround:** the host uses `inject = "always"` with Basic authentication
  for `github.com`, so Box attaches the credential to every request there.
  `api.github.com` keeps a phantom `token` header that `gh` sends from
  `GITHUB_TOKEN`.
- **Upstream status:** expected Box behavior for phantom routes, not a defect.

## Every process in a Box execution can use every route

- **Symptom:** any process in the execution, including tools and MCP servers,
  can send authenticated requests to GitHub through Box's routes.
- **Cause:** Box routes are per execution, not per process. The host also
  passes the token in the `box run` process environment, which processes of
  the same host user can read from `/proc`.
- **Workaround:** run one Agent per Box execution, and run the host as a
  dedicated operator account with no other processes.
- **Upstream status:** by design in Box v0.2.2. The `authorizer://` source
  keeps the token out of the `box run` environment.

## Box refuses protocol upgrades on HTTP egress

- **Symptom:** a WebSocket or other `Upgrade` request from inside Box fails.
- **Cause:** Box v0.2.2's HTTP egress proxy
  [refuses protocol upgrades](https://github.com/strands-agents/box/blob/d9346bf0d281153ea7dc6338ad1f0b7e122be687/crates/egress-gateway/src/intercept/mitm/http1.rs#L277-L285).
- **Workaround:** the file-only workspace node runs outside Box on its own route
  to the Agent Gateway, and the Harness reaches the Gateway through the
  installed relay. See [Connect the installation](README.md#connect-the-installation).
- **Upstream status:** not yet reported to strands-agents/box.

## Box ships for Linux ARM64 only

- **Symptom:** the pinned Box v0.2.2 release has no Linux x86-64 build, and
  the Box host cannot run on an x86-64 machine.
- **Cause:** the release publishes Linux ARM64 and macOS ARM64 builds only. This
  example uses the Linux build.
- **Workaround:** use an ARM64 Linux host, or a full-system ARM64 virtual machine.
  User-mode emulation is not enough, because Box needs user and network
  namespaces and Bubblewrap from the kernel it runs on. API, Worker and the
  workspace volume must sit on the same node, so that node is ARM64 too.
- **Upstream status:** not yet reported to strands-agents/box.

## Ubuntu 24.04 restricts unprivileged user namespaces

- **Symptom:** on a stock Ubuntu 24.04 host, Box and Bubblewrap fail as a
  nonroot user, for example with `uid_map` permission errors.
- **Cause:** Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`,
  and AppArmor denies user namespaces to programs without a profile that allows
  them.
- **Workaround:** before you start Box, install AppArmor profiles that allow user
  namespaces for the Box and Bubblewrap binaries. Or, on a dedicated host, set
  `kernel.apparmor_restrict_unprivileged_userns=0`.
- **Upstream status:** host prerequisite, not a Box defect. It is not yet in the
  Box documentation.
