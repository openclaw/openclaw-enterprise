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
- **Workaround:** none for mutual TLS. Identify the Box execution with a
  per-execution bearer token that Box injects as a credential for that one
  destination. The [fixed-repository sender](git/README.md) still documents client
  certificates and cannot be reached from inside Box until it changes to that
  model. The example Driver refuses protected repository wiring.
- **Upstream status:** not yet reported to strands-agents/box.

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
