# Public GitHub read tests

Run the controlled transport tests from the repository root:

```sh
node --test tests/integration/public-github-git-transport.test.mjs
```

These checks use loopback TLS. Native runtime and installed Agent checks require
their separate dependencies below. The [feature reference](../reference/public-github-reads.md)
owns supported behavior and operator configuration.

## Controlled and native checks

The public reader owns an HTTP listener for anonymous API GET and Git upload-pack
requests to fixed GitHub origins. The source guard forbids imports
between the reader and credential owners; its boundary test uses a local TLS
provider. PR CI's Image Runtime Startup case separately checks limited-mode
API GET through Codex interception and full-method native Git through an enabled
reader-host-restricted proxy. The latter retains the filesystem/exec sandbox,
disables local binding, SOCKS and upstream proxying, and checks unauthorized-host,
repository and push denials alongside clone/API/fetch/new-object proof. Full-mode
HTTPS is tunneled, not MITM-intercepted; host domains are not port/path rules.
Neither mode selects danger-full-access. These checks need no model or repository
credentials and require actual Linux execution before qualification. Both native and K3d reader fixtures serve a
separate `CA:false` server-auth leaf and project only its public issuer as trust.
Fixture metadata checks do not establish native Rustls success. The native test
captures at most 64 passive TLS/HTTP event receipts before teardown, with collection
and truncation flags. Model-tool diagnostics retain fixed preflight stages, exit
status, validated helper refusal phase/code and known error classes; unknown
failures remain unknown without raw stderr.

`node --test tests/integration/public-github-git-transport.test.mjs` checks the
actual launcher and Git/API helper with verified loopback TLS. Consecutive peer
roots introduced after installation prove current-tool trust composition;
wrong-hostname/unrelated roots, malformed trust, redirects and denied capabilities
remain failures. Git clone/fetch uses the admitted runtime workspace when ambient temporary roots
are missing or read-only. Invalid selected workspaces fail without fallback or
private diagnostic output; authenticated Git delegation does not depend on public scratch.
A real reader 401 must not invoke public Git askpass, including on Git 2.39.5;
a bound provider challenge must still reach its authenticated askpass. Concurrent cancellation checks
verify private directory/file modes and independent cleanup of public-only bundles.
The native fixture supplies the same existing workspace variable as production,
without changing its filesystem grants. These tests do not establish cleanup after
uncatchable termination; Git public-CA residue can remain.
API cases instead ignore unavailable scratch roots and exercise in-memory
trust, isolated Node startup with a fixed executable path, large distinct public-root
bundles, SIGTERM/SIGINT
and the 24-second parent deadline, including a proxy holding CONNECT. Host checks
exercise the same Node client. The Linux proxy owner sets the legitimate bare
`process.execPath` fallback before importing the actual helper and poisons ambient
PATH; this proves component lookup/privacy, not native proc behavior. The native
filesystem/proxy still needs Linux proof.
The native fixture adds a separate Limited read-only API body/metadata control,
asserts workspace write denial and no residue, and retains the Limited
workspace-write POST-denial and Full workspace-write Git controls: a
read-only clone failure would not prove POST denial. All native controls still need
actual Linux execution. The tests also follow a real reader's two-page list through the fixed metadata mode,
reject malformed/oversized continuation data and suppress unrelated headers.
These host checks do not prove Codex's interception or its upstream store: require the stock
Linux native clone/API/fetch test and installed Agent qualification separately.
The OpenShell QA's raw receive-pack request uses the current tool CA bundle only
to prove the reader's exact HTTP refusal; it is not the managed API caller.

The Sandbox startup suite checks reader material larger than OpenShell's 8 KiB
configuration-value limit. Its provider projection must retain exact file bytes
in a stable profile shared across Agents, with each configuration chunk within
the supplier limit. This is protocol-fixture proof, not an installed supervisor run.

## Installed OpenShell scenario

Select `public-github-git` alone with the `Codex` preset and `compose`
installation. It creates a separate Compose control plane with Kubernetes Compute
and OpenShell, enables bundled presets in its Installation input, and reloads the
Namespace catalog before creating an Agent. It uses ordinary, unprotected execution
and narrows the launcher's exact direct GitHub rule to no endpoints for this test.
The outer OpenShell policy must then deny GitHub before Agent opt-in. Other
OpenShell defaults and provider-selected native execution settings stay unchanged.
It reads the deployed policy through the public Sandbox policy API and checks the
reader registry's revision identity, selected scope and live lease. Internal
admission snapshots are not part of the public revision DTO. The authored native
proxy permits full HTTP methods for Git upload-pack, with an exact reader-host
allow and no local binding. It selects `runtime.modelProvider` with the `openai-responses` protocol.
Supply the same protected API-key inputs as `codex-search-config`, plus a Responses
model that supports Codex's custom tools. The hosted job uses the environment's
`OCC_TEST_QA_CODEX_MODEL`, shared with other Codex jobs. No GitHub App credential is required.

For local execution, `OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman` selects Podman.
This Compose topology needs a `docker-compose` provider that accepts
`--project-directory`. Rootful Podman on macOS also needs the exact selected VM
gateway `/32` in the existing `OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR` setting.
The scenario uses live anonymous `github.com` reads, a shallow clone and an
unshallow fetch with additional commit objects. It appends its disposable reader
CA to a stock supervisor image's system roots and records that image distinction.
Installed ordinary workflow qualification remains pending. Paired protected
execution, known-private denial, protected fork read/write coexistence, and
ten-minute expiry isolation require separate proof; an unavailable URL does not prove private repository isolation.

Use the [QA matrix procedure](ci/qa-advisory.md#run-local-qa) with this exclusive
selection. A passing result must include the selected scenario without skips.

## Failure diagnostics

On a public Git failure, `compose-public-git-provision-failure.json` retains at
most 20 worker records for the scenario's Agent revisions. It includes only fixed
event, error-category, code and preparation-step values. It distinguishes runtime
material, provider ownership, Sandbox ownership and workspace initialization
failures without retaining exception text or configuration. Missing diagnostics
do not replace the original failure; a failed deployment provides no clone/fetch proof.
