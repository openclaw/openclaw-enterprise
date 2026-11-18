# Strands Box known gaps

What an operator deploying this example must know.

## Upstream TLS trusts only Box's built-in public roots

- **Symptom:** the first model request from Box fails its upstream TLS
  handshake when the controlled inference endpoint uses a private IPv4
  address, a `.svc.cluster.local` name, or a private CA's certificate.
- **Cause:** released Box (v0.2.3 and earlier) verifies every upstream
  certificate against public roots compiled into it, and no setting adds
  another CA.
- **Workaround:** use an operator DNS name pinned to one private IPv4 address
  with a publicly trusted certificate, or a Box build that reads `[gateway]
upstream_ca_file` (the [Box build](README.md#which-box-build)). Box trusts that bundle for
  every upstream, so every route Box dials must declare its digest. See
  [Controlled inference route](driver/README.md#controlled-inference-route).
- **Upstream status:** reported as
  [strands-agents/box#54](https://github.com/strands-agents/box/issues/54);
  [strands-agents/box#147](https://github.com/strands-agents/box/pull/147) (open)
  adds the gateway-wide key.

## Box presents no client certificate

- **Symptom:** a TLS client certificate set inside Box never reaches the
  server, which refuses Box if it identifies callers by certificate.
- **Cause:** Box builds both TLS legs of every `CONNECT` without client
  authentication.
- **Workaround:** none for mutual TLS; the paired registration uses a
  per-execution bearer instead.
- **Upstream status:** not reported upstream.

## GitHub access needs the Box fork's request-time credential source

- **Symptom:** released Box (v0.2.3 and earlier) refuses the host's
  `box.toml` for a protected execution: `[gateway.credential_source.oce]`, `source://` route
  secrets and `[gateway] upstream_ca_file` are unknown keys.
- **Cause:** the paired registration has Box inject GitHub credentials itself
  and ask OCE, through the host and the Worker's paired Driver, about each
  request its policy permits; `requests.authorize` decides and records it.
  Released Box has no such hook.
- **Workaround:** use the [Box build](README.md#which-box-build) from the
  public fork. On Linux x86-64 the host sets `EXPERIMENTAL_X86_SUPPORT=TRUE`
  for `box run`. Use only on a dogfood host with a test repository.
- **Upstream status:** the source is the fork's
  `feature/request-credential-source`. Nothing is filed with
  strands-agents/box yet.

## OCE applies no draft or branch rule to gh's GitHub API requests

- **Symptom:** OCE authorizes and records every request, but a non-draft pull
  request, a second draft, or a push to any branch the installation token
  permits succeeds.
- **Cause:** stock `gh pr create` uses GraphQL, so the Driver asks OCE with the
  `github_repository` profile, which, as on OpenShell, checks method, route and
  repository for Git and REST but not a GraphQL request's repository, and has
  no draft, ref or one-draft rule; `repository_git` has those but refuses REST
  and GraphQL.
- **Workaround:** keep branch protection on the base branch. Grant the App only
  Contents, Pull requests and Metadata on the selected repository.
- **Upstream status:** an OCE gap. A draft rule for GraphQL `createPullRequest`
  under `github_repository` needs an OCE decision.

## GitHub requests fail while the Worker is unavailable

- **Symptom:** while the Worker restarts, or before it confirms a renewed
  installation token, GitHub requests fail with `403` and `credential refused
by its source: route_not_ready`. The chat keeps running.
- **Cause:** only the Worker's paired Driver can ask OCE. The host refuses an
  ask unanswered within Box's 5-second timeout; the Driver refuses until OCE
  confirms the execution's current token version.
- **Workaround:** retry about a second after the Worker is back.
- **Upstream status:** by design. The request-time source fails closed.

## Box connects upstream before it asks the source

- **Symptom:** a request that OCE refuses still opens a TCP connection to the
  upstream, with no request bytes and no credential.
- **Cause:** Box dials the upstream when the workload's `CONNECT` arrives; its
  policy and credential sources see the request only inside the tunnel.
- **Workaround:** none needed. Count refusals from OCE's use records.
- **Upstream status:** Box behavior; not reported.

## A phantom credential cannot carry Git's first request

- **Symptom:** with a `phantom` route on `github.com`, every stock Git request
  fails with `403`.
- **Cause:** Git's first smart-HTTP request carries no credential and waits for
  a `401` challenge, which a phantom route never lets through.
  `http.proactiveAuth` needs Git 2.46 or later.
- **Workaround:** the host uses `inject = "always"` with Basic authentication
  for `github.com`; `api.github.com` keeps a phantom `token` header that `gh`
  sends from `GITHUB_TOKEN`.
- **Upstream status:** expected Box behavior.

## git and gh run programs the Agent writes, inside their own boundary

- **Symptom:** on a protected repository run the Agent's shell starts only `git`
  and `gh`, from the workspace, yet their children run unmediated: a hook,
  `core.fsmonitor`, `credential.helper`, an `ext::` command, or a checked-out binary.
- **Cause:** Box decides `shell:spawn` once per program. The host gives each
  program its own `[tool]` boundary, which its children keep: `git` reads and
  writes the workspace, `gh` reads it and runs `git`, both see Box's system
  libraries, TLS roots and gateway CA, not the Codex home, hook directory,
  bridge, model source, `/bin/sh`, an interpreter, or Git or `gh`
  configuration outside the workspace. The workspace's `.codex` and the
  verifier's marker are denied. Every route reaches them: Box cannot attribute
  a request to a process. The shell's own commands, Python and Lua included,
  reach only the workspace and `/dev/null`. Codex itself, with `apply_patch`,
  keeps the agent's whole boundary. Its turn-start `git status` once ran a
  workload `clean` filter (Node) there, so the host refuses an exec grant
  covering `git`, `gh` or git's helpers, and Codex works without git
  information. Box's loader directories stay executable in every boundary, so
  Debian's `/usr/lib/git-core/git` runs there by full path. The host refuses, at
  start, an agent `PATH` or runtime-added directory leading to git or gh; code
  already in the agent's boundary can plant one later. The Gateway, a
  Kubernetes workload outside Box, has git in its image and no copy of this
  workspace (files go through the paired node); its git features
  (new-workspace repository, Control UI diff panel, project clones, worktree
  sessions) are unverified on Box. A root `AGENTS.md` and skills under
  `.codex/skills` and `.agents/skills` reach the prompt; git and the shell can
  write all but `.codex/skills`. This Codex version ignores
  `.codex/config.toml`, which `apply_patch` can write: Codex behavior, not a
  host control.
- **Workaround:** run one Agent per execution; grant the App only what it
  needs; set a Git identity in the repository; treat the workspace and that
  prompt content as written by any code the Agent runs. **Never run `git` in an
  Agent's workspace from the Box host:** its hooks, `core.fsmonitor` and filters
  run as the host user. Codex's `-c` overrides stop only the first two; copy
  files out instead.
- **Upstream status:** Box behavior in v0.2.2; not reported.

## Codex can read the native hook credential and forge its own callbacks

- **Symptom:** Codex, `apply_patch` and the hook command can read, overwrite or
  delete the hook relay credential in `/home/node/.oce-native-hooks` and POST
  hook callbacks to the Gateway with it. On OpenShell sandboxed commands cannot.
- **Cause:** the host adds the directory to the agent's write list so the
  Gateway can deliver the credential, and Box grants per boundary, not per
  process. The shell's commands and `git`/`gh` cannot read it; the permitted
  hook command reads it for them only by its file name, whose generation is random.
- **What the token allows** (confirmed live): a holder also needs the current
  Codex thread and turn ids, readable in `~/.codex/sessions`. With them, forged
  `pre_tool_use`, `post_tool_use` and `before_agent_finalize` return 200,
  identical bodies replay, the Gateway logs nothing, and a forged `pre_tool_use`
  decision returns only to the forger. A forged `post_tool_use` reaches the
  Gateway's subagent-submission bookkeeping; that and `before_agent_finalize`'s
  Gateway-side effects are not verified. A forged `permission_request` got 500
  and no prompt. Other relays, sessions, generations and turns are
  refused (403 or 410), Box refuses every other path, method and Agent, and the
  token stops working about 17 s after the turn. The hook refuses a link at the
  credential's name, but the name is fixed per chat session, and a link planted
  between turns makes Codex write the next credential through it, for example
  into a workspace file the tools can read.
- **Impact:** the hook fails closed on a refused, corrupt or missing
  credential; a hook that times out (10 s) is non-blocking in stock Codex and
  the call runs. Approving a call the Gateway would refuse is not shown (no
  refusal source was configured); no forgery reached another Agent.
- **Workaround:** run one Agent per Box execution. Closing it needs the
  credential-handling process apart from the workload (the shared-kernel gap).
- **Upstream status:** by design in Box v0.2.2. The ask: a per-process or
  trusted-process-only grant for the hook directory.

## Any local process on the Box host can use Box's egress gateway

- **Symptom:** a process on the Box host outside the execution, including
  sandbox-escaped code running as the host user, can send requests through the
  execution's egress gateway; on `github.com` Box attaches the installation token.
- **Cause:** `box run` serves its gateway on host loopback with no peer check
  and no token.
- **Workaround:** dedicate the host (or virtual machine) and its user to Box,
  with no other untrusted local processes.
- **Upstream status:** not reported. The ask: an owner-only Unix socket or a
  per-execution gateway token.

## Box's trusted process shares a kernel with the workload

- **Symptom:** code that escapes Box's sandbox lands in the same host account
  as the process holding the installation token and the non-expiring model key.
- **Cause:** Box's boundary is operating-system process sandboxing, not a
  virtual machine; its gateway and credential handling run in the one `box run`
  process on the workload's kernel, and kernel-exploit resistance is a Box
  non-goal. Host-account code can also present the execution bearer at
  `model.sock`, or serve the Worker's control socket, and receive this Agent's
  model key, never another Namespace's; the Worker answers only for OCE's
  committed installation of this execution
  ([Protected model route](driver/README.md#protected-model-route)).
- **Workaround:** none in Box. `box run` is not dumpable, so its token is
  readable only by root or a ptrace-capable process; a same-user escape can
  still use it through the loopback gateway. A stolen token works on the
  assigned repositories until OCE revokes or renews it: at most one hour. Keep
  the host dedicated and patched. Give each Agent a revocable, rate-limited
  model-proxy key, not a provider account key.
- **Upstream status:** open upstream as
  [strands-agents/box#24](https://github.com/strands-agents/box/issues/24) and
  [strands-agents/box#25](https://github.com/strands-agents/box/issues/25).
  The fork's request-time credential source keeps the token out of `box run`
  and lets OCE refuse each request.

## The package keeps the protected model key at rest

- **Symptom:** a protected Agent's model API key exists in a Kubernetes Secret
  the package owns, beside OCE's own copy, and the [Role](model-gateway-rbac.yaml)
  gives the API and the Worker `get` on every such Secret, of every Namespace.
- **Cause:** the package's Credential Gateway view gets the value only at
  `registerSource` and `updateSource` in the API; the Worker answers each Box
  model request later. It keeps one Secret per source in
  `modelGateway.secretNamespace`; Kubernetes has no metadata-only read.
- **Workaround:** use a namespace holding nothing else, and grant no one else
  `get` on Secrets there. Removing the source deletes its Secret.
- **Upstream status:** an OCE question: a Worker-side read of OCE's own Secret
  would remove the copy.

## A model revoke is permanent for its revision

- **Symptom:** a withdrawn revision never gets model access on this host again.
- **Cause:** the host writes a receipt for the revision and source in
  `protectedModel.revocationDir`, running execution or not, and every start of
  that revision loads it.
- **Workaround:** deploy a new revision. To undo a mistaken withdrawal, stop the
  host and move the `model-revoked-*.json` file out of that directory.
- **Upstream status:** by design in this example.

## Withdrawing a model source needs an active revision

- **Symptom:** withdrawing a model source from a stopped Agent returns `409`
  ("no active revision to withdraw the credential source from"), and no receipt
  is written.
- **Cause:** OCE accepts a withdrawal only against the active revision, before
  the package's Gateway view sees it.
- **Workaround:** withdraw before you stop the Agent. On a stopped Agent,
  `DELETE` the source, which also deletes the package's Secret.
- **Upstream status:** an OCE change: accept it for the last revision that held
  the source.

## Protected model requests are limited to 16 MiB

- **Symptom:** a model request body over 16 MiB fails inside Box, before any
  byte reaches the provider.
- **Cause:** Box sends the whole body to the host's model source, capped at
  16 MiB.
- **Workaround:** keep conversations under the cap; compact long ones.
- **Upstream status:** Box's own limit; not reported.

## Optional history injection into a Codex thread fails in Box

- **Symptom:** a feature that injects history into a Codex thread fails with
  `The provider Box refused a Codex request before dispatch
(rpc-thread-inject-items)`. Ordinary chat, including sessions from before a
  redeploy, works.
- **Cause:** the runtime image's provider-Box fence admits `thread/inject_items`
  only for the Gateway's session policy handoff: one developer-role text message
  into a thread the same connection opened. History seeding, settled-turn
  finalization, conversation binding transfer and the progress-card restore
  after compaction stay refused.
- **Workaround:** leave these features off; a failed progress-card restore is
  only logged.
- **Upstream status:** by design in OCE's runtime image.

## Codex Code Mode cannot run in Box

- **Symptom:** a model's Code Mode `exec` call fails with `failed to spawn
code-mode host ... Permission denied (os error 13)`; the model then uses its
  shell tool, which runs under the hook as usual.
- **Cause:** Codex starts its Code Mode host, a separate binary beside `codex`,
  as its own child, and the agent's exec list names only `tini`, Node and `codex`.
- **Workaround:** none needed: the call fails before any code runs. Do not add
  it to the exec list: it would run model-written JavaScript in the
  agent's boundary unadmitted.
- **Upstream status:** turning Code Mode off needs an OCE change to the Codex
  configuration it renders.

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
- **Upstream status:** not reported upstream.

## Box releases ship for Linux ARM64 only

- **Symptom:** no Box release up to v0.2.3 has a Linux x86-64 build.
- **Cause:** the releases have Linux and macOS ARM64 builds only. Upstream
  builds Linux x86-64 as experimental, behind `EXPERIMENTAL_X86_SUPPORT=TRUE`.
- **Workaround:** on Linux x86-64, use the [Box build](README.md#which-box-build);
  the host sets the switch. The proven runs used this. On ARM64, use a Linux
  host or a full-system ARM64 virtual machine (Box needs namespaces and
  Bubblewrap from its kernel) with API, Worker and the workspace volume on
  that node; no installed OCE run has been made there.
- **Upstream status:** upstream added x86-64 release downloads
  ([strands-agents/box#475](https://github.com/strands-agents/box/pull/475));
  v0.2.3 ships none.

## Ubuntu 24.04 restricts unprivileged user namespaces

- **Symptom:** on a stock Ubuntu 24.04 host, Box and Bubblewrap fail as a
  nonroot user, for example with `uid_map` permission errors.
- **Cause:** `kernel.apparmor_restrict_unprivileged_userns=1` denies user
  namespaces to programs without an AppArmor profile that allows them.
- **Workaround:** install such profiles for the Box and Bubblewrap binaries,
  or, on a dedicated host, set `kernel.apparmor_restrict_unprivileged_userns=0`.
- **Upstream status:** a host prerequisite, not in Box's documentation.
