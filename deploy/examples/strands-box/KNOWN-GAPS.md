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
  private IPv4 address, then use a publicly trusted certificate for that name,
  or a Box build that reads `[gateway] upstream_ca_file` (the fork's
  `dogfood/main`) with the host's upstream CA bundle. Box trusts that bundle for
  every upstream, so the host starts only when every route Box dials declares its
  digest; an inline workspace node must opt in or use the separate file node. See
  [Controlled inference route](driver/README.md#controlled-inference-route).
- **Upstream status:** reported as
  [strands-agents/box#54](https://github.com/strands-agents/box/issues/54);
  [strands-agents/box#147](https://github.com/strands-agents/box/pull/147) (open)
  adds the gateway-wide key. Per-route CA scoping would remove the opt-ins.

## Box presents no client certificate

- **Symptom:** a TLS client certificate configured inside Box (for example
  `git -c http.sslCert` or `curl --cert`) never reaches the server. A server that
  identifies the caller by its certificate refuses every request from Box.
- **Cause:** Box intercepts every `CONNECT` and builds both TLS legs without
  client authentication.
- **Workaround:** none for mutual TLS. The paired registration identifies the
  execution by a per-execution bearer instead.
- **Upstream status:** not yet reported to strands-agents/box.

## GitHub access needs the Box fork's request-time credential source

- **Symptom:** a released Box v0.2.2 refuses the host's `box.toml` for a
  protected execution: `[gateway.credential_source.oce]`, `source://` route
  secrets and `[gateway] upstream_ca_file` are unknown keys.
- **Cause:** the paired registration lets Box inject GitHub credentials itself
  and ask OCE for each request. After Box's policy permits a request, Box sends
  it to the host's credential source, the host relays it to the paired Driver
  in the Worker, and OCE's `requests.authorize` decides it and records the use.
  Released Box has no such hook.
- **Workaround:** build `strands-box`, `strands-box-sock-alias` and
  `strands-box-contain-trampoline` from the fork's `dogfood/main` and install
  them side by side. Use a fresh `box_dir`, because the fork writes record
  versions v0.2.2 cannot read. On Linux x86-64, the host sets
  `EXPERIMENTAL_X86_SUPPORT=TRUE` for `box run`. Use only on a dogfood host
  with a test repository.
- **Upstream status:** the fork's credential source is drafted for
  strands-agents/box with the owner. Nothing is filed yet.

## OCE applies no draft or branch rule to gh's GitHub API requests

- **Symptom:** OCE authorizes and records every request, but a non-draft pull
  request, a second draft, or a push to any branch that the installation token
  permits succeeds.
- **Cause:** stock `gh pr create` uses GitHub GraphQL, so the Driver asks OCE
  with the `github_repository` profile. As on OpenShell, it checks the method,
  the route and the repository of Git and REST requests, but has no draft, ref or
  one-draft rule and does not read the repository a GraphQL request names; the
  installation token covers only the assigned repositories. Those rules exist only
  in the `repository_git` profile, whose classifier refuses REST and GraphQL.
- **Workaround:** keep branch protection on the base branch. Grant the App only
  Contents, Pull requests and Metadata on the selected repository.
- **Upstream status:** an OCE gap, not a Box one. A draft rule for GraphQL
  `createPullRequest` under `github_repository` needs an OCE decision.

## GitHub requests fail while the Worker is unavailable

- **Symptom:** while the Worker restarts, or before it confirms a renewed
  installation token, GitHub requests from the execution fail with `403` and
  `credential refused by its source: route_not_ready`. The chat keeps running.
- **Cause:** Box asks for every request and the host has no credential of its
  own. Only the Worker's paired Driver can ask OCE. The host refuses an ask that
  gets no answer within Box's 5-second timeout, and the Driver refuses an ask
  until OCE's current token version is confirmed for the execution.
- **Workaround:** retry once the Worker is back; it confirms a renewed token on
  its next pass, about a second later. Box keeps running.
- **Upstream status:** by design. The request-time source fails closed.

## Box connects upstream before it asks the source

- **Symptom:** a request that OCE refuses still opens a TCP connection from the
  Box host to `github.com`, `api.github.com` or the model endpoint (for example
  during a model withdrawal). The upstream receives no request bytes and no
  credential.
- **Cause:** Box dials the upstream when the workload's `CONNECT` arrives. Its
  policy and credential sources see the request only after the TLS tunnel exists.
- **Workaround:** none needed for credential custody. Count refusals from OCE's
  use records, not from connection logs.
- **Upstream status:** Box behavior; not reported.

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

- **Symptom:** any process in the execution, including tools, MCP servers, `git`
  and `gh`, can send authenticated requests to GitHub and to the model endpoint
  through Box's routes.
- **Cause:** Box routes are per execution: Box cannot attribute a request to a
  process.
- **Workaround:** run one Agent per Box execution and grant the App only the
  repositories and permissions the Agent needs.
- **Upstream status:** by design in Box v0.2.2.

## git and gh run programs the Agent writes, inside their own boundary

- **Symptom:** on a protected repository run the Agent's shell starts only `git`
  and `gh`, from the workspace, yet their children run unmediated: a hook,
  `core.fsmonitor`, `credential.helper`, an `ext::` command, or a checked-out binary.
- **Cause:** Box decides `shell:spawn` once per program. The host gives each
  program its own `[tool]` boundary, which its children keep: `git` reads and
  writes the workspace, `gh` reads it and runs `git`, and both see Box's system
  libraries, TLS roots and gateway CA. They see no Codex home, hook directory,
  bridge socket, model source, `/bin/sh`, Node or other interpreter, and no Git
  or `gh` configuration outside the workspace; the workspace's `.codex` and the
  verifier's marker are denied. Every route reaches them, as above. The shell's
  own commands, Python and Lua included, reach only the workspace and
  `/dev/null`. Codex itself, with `apply_patch`, keeps the agent's whole boundary.
- **Workaround:** set a Git identity in the repository (`git config user.email`).
  Treat the workspace as writable by any code the Agent runs. The
  [native hook credential gap](#codex-can-read-the-native-hook-credential-and-forge-its-own-callbacks)
  stays reachable through Codex, and the
  [shared-kernel gap](#boxs-trusted-process-shares-a-kernel-with-the-workload)
  from any boundary.
- **Upstream status:** Box behavior in v0.2.2; not reported.

## Codex can read the native hook credential and forge its own callbacks

- **Symptom:** the Agent's own processes (Codex, `apply_patch`, the hook command)
  can read, overwrite or delete `/home/node/.oce-native-hooks`, the native
  PreToolUse hook relay credential `{url, token}`, and POST hook callbacks to the
  Gateway with it. On OpenShell the commands Codex sandboxes cannot reach it.
- **Cause:** the example host adds the directory to the `[agent.filesystem]`
  write list so the Gateway can deliver the credential, and Box grants per
  boundary, not per process. Codex runs under `externalSandbox`, so only Box's
  grants bound it. The shell's commands and `git`/`gh` cannot reach it.
- **What the token allows** (independent fence review; live confirmation **not
  run**): callbacks for **this relay and generation only**, any allowed event and
  payload. A forged `pre_tool_use` returns a decision to the caller only; a forged
  `permission_request` raises an operator prompt with forged input, and an
  allow-always grant still needs the operator; a forged `post_tool_use` reaches
  subagent-submission bookkeeping when `onNativeSubagentSubmission` is set (impact
  not verified). It grants no other relay, node or operator route. A symlink at
  the credential's predictable name can redirect the Gateway's write onto a
  Box-writable file, with no privilege gain; `/home/node` is not writable.
- **Impact:** with the start-time admission self-check the hook fails closed, so
  tampering can at most deny the workload's own tools. It cannot approve a call
  the Gateway would refuse or reach another Agent.
- **Workaround:** run one Agent per Box execution. Closing it needs the trusted
  credential-handling process apart from the workload (the shared-kernel gap below).
- **Upstream status:** by design in Box v0.2.2. The ask is a per-process or
  trusted-process-only grant for the hook directory.

## Any local process on the Box host can use Box's egress gateway

- **Symptom:** a process on the Box host outside the execution, including code
  that escapes Box's sandbox as the host user, can send requests through the
  execution's egress gateway. On the `github.com` route, which uses
  `inject = "always"`, Box attaches the installation token to them.
- **Cause:** `box run` serves its gateway on host loopback (`127.0.0.1:0`) with
  no peer check and no token, though the gateway crate supports an owner-only
  Unix socket. Unchanged on upstream main.
- **Workaround:** run one Box host per virtual machine or dedicated host, as a
  dedicated user, with no other untrusted local processes.
- **Upstream status:** not yet reported to strands-agents/box. The ask is for
  `box run` to serve its gateway on an owner-only Unix socket or to require a
  per-execution token.

## Box's trusted process shares a kernel with the workload

- **Symptom:** code that escapes Box's sandbox lands on the same host, and in
  the same host account, as the process that holds the installation token.
- **Cause:** Box's boundary is operating-system process sandboxing, not a
  virtual machine; its egress gateway and credential handling run in the one
  trusted `box run` process on the workload's kernel. A kernel escape defeats
  it, and Box lists kernel-exploit resistance as a non-goal.
- **Workaround:** none in Box. The `box run` process is not dumpable, so a token
  it holds is readable only by root or a ptrace-capable process; a same-user
  escape can still use it through the loopback gateway above. Code that obtains
  the token has the App installation's permissions on the assigned repositories
  from anywhere until OCE revokes it at withdrawal or retires it at renewal: at
  most one hour. Keep the host dedicated and its kernel patched.
- **Upstream status:** open upstream as
  [strands-agents/box#24](https://github.com/strands-agents/box/issues/24)
  (host-side gateway and credential vault outside the workload's kernel) and
  [strands-agents/box#25](https://github.com/strands-agents/box/issues/25)
  (host-assigned sandbox identity). A request-time credential source in the Box
  fork keeps the token out of `box run` and lets OCE refuse each request.

## The package keeps the protected model key at rest

- **Symptom:** a protected Agent's model API key exists in a Kubernetes Secret
  the package owns, beside OCE's own copy, and the [Role](model-gateway-rbac.yaml)
  gives the API and the Worker `get` on these Secrets: each can read every stored
  key, of every Namespace.
- **Cause:** the package's Credential Gateway view gets the value only at
  `registerSource` and `updateSource`, in the API, and the Worker answers each
  Box model request later. It keeps one Secret per source, for every Namespace,
  in `modelGateway.secretNamespace`. Status reads, the ownership check, updates
  and removal preconditions need the Secret, and Kubernetes has no metadata-only
  read.
- **Workaround:** use a namespace that holds nothing else, and grant no one else
  `get` on Secrets there. Removing the source deletes its Secret.
- **Upstream status:** an OCE question: a Worker-side read of OCE's own Secret
  would remove the copy.

## Code that escapes Box can obtain the model key

- **Symptom:** the [shared-kernel gap](#boxs-trusted-process-shares-a-kernel-with-the-workload)
  covers the model key too, and that key does not expire.
- **Cause:** `box run` holds each released key while sending. Host-account code
  can also present the execution bearer at `model.sock`, or serve the Worker's
  control socket, and receive this Agent's key, never another Namespace's. The
  Worker answers only for OCE's committed installation of this execution: before
  OCE confirms the recipient, at the fence of its first model ask and only while
  the host shows the live `box run`; after it, at the confirmed fence.
- **Workaround:** keep the host dedicated. Give each Agent a revocable,
  rate-limited key from a model proxy, not a provider account key.
- **Upstream status:** as above.

## A model revoke is permanent for its revision

- **Symptom:** a withdrawn revision never gets model access on this host again.
- **Cause:** the host writes a receipt for the revision and source in
  `protectedModel.revocationDir`, with or without a running execution, and
  every start of that revision loads it.
- **Workaround:** deploy a new revision. To undo a mistaken withdrawal, stop the
  host and move the `model-revoked-*.json` file out of that directory.
- **Upstream status:** by design in this example.

## Protected model requests are limited to 16 MiB

- **Symptom:** a model request body over 16 MiB fails inside Box, before any
  byte reaches the provider.
- **Cause:** Box sends the whole body to the host's model source and caps it at
  16 MiB. The host checks the target and discards the body.
- **Workaround:** keep conversations under the cap; compact long ones.
- **Upstream status:** Box's own limit; not reported.

## Codex remote plugin bundles have no route in protected Box

- **Symptom:** a Codex remote plugin bundle download fails in a protected
  execution.
- **Cause:** a protected execution gets only its GitHub, model and Gateway
  routes; the empty protected artifact policy adds none, as on OpenShell.
- **Workaround:** use plugins already in the runtime image.
- **Upstream status:** by design.

## Box refuses protocol upgrades on HTTP egress

- **Symptom:** a WebSocket or other `Upgrade` request from inside Box fails.
- **Cause:** Box v0.2.2's HTTP egress proxy
  [refuses protocol upgrades](https://github.com/strands-agents/box/blob/d9346bf0d281153ea7dc6338ad1f0b7e122be687/crates/egress-gateway/src/intercept/mitm/http1.rs#L277-L285).
- **Workaround:** the file-only workspace node runs outside Box on its own route
  to the Agent Gateway, and the Harness reaches the Gateway through the
  installed relay. See [Connect the installation](README.md#connect-the-installation).
- **Upstream status:** not yet reported to strands-agents/box.

## Box ships for Linux ARM64 only

- **Symptom:** the pinned Box v0.2.2 release has no Linux x86-64 build.
- **Cause:** the release publishes Linux ARM64 and macOS ARM64 builds only.
- **Workaround:** use an ARM64 Linux host or a full-system ARM64 virtual machine;
  user-mode emulation is not enough, because Box needs user and network
  namespaces and Bubblewrap from its kernel. API, Worker and the workspace
  volume must sit on that node. A build of the fork's `dogfood/main` also runs on
  Linux x86-64 with `EXPERIMENTAL_X86_SUPPORT=TRUE`, which the host sets for `box run`.
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
