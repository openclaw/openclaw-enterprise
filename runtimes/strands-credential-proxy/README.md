# Reference protected sender

This library implements Box's `RequestExchange` for one enrolled
`POST /v1/responses` route. It uses the current OCE signed installation exchange
to resolve a credential, request fresh send authority, and protect the response.
The protobuf retains its existing `openshell.middleware.v1` wire name; this does
not make the sender an OpenShell sandbox or add a second credential API.

The host supplies Box policy and the original client writer. The sender consumes
Box's single-use origin connection capability, authenticates TLS, and checks the
permit at the first underlying socket write after the TLS handshake.
The socket gate stays armed while TLS buffers plaintext or the socket is pending. Refusal never selects Box's direct writer.
Once dispatch is possible, failure is uncertain and must not be retried.

## Build from public source

From the repository root, with Rust 1.98.1, protoc, curl, tar, and patch installed:

```sh
bash runtimes/strands-credential-proxy/prepare-box.sh
cargo build --locked --manifest-path runtimes/strands-credential-proxy/Cargo.toml --features reference-gateway
cargo test --locked --manifest-path runtimes/strands-credential-proxy/Cargo.toml --lib
```

The preparation script downloads Box commit
`1ad7e987af6db807d66d896600c76a7d8d100b32` from
[strands-agents/box](https://github.com/strands-agents/box) and applies
`upstream/box-request-exchange.patch`. That patch supplies the native containment transport and Box-owned terminal
exchange interface; it is not an upstream release. The generated `build-input/`
directory is ignored. `--source /path/to/box` can use a local Git object store as
a download cache, but always exports the same public commit, not its worktree.

The prepared source matches Box integration commit
`cf6ea62fc1cd4373dcca8734d76faf7ecc402d2e`, including the native bridge and
containment changes, not just the gateway. Both `strands-box` and
`strands-box-egress-gateway` resolve from this same materialized tree. Source
preparation needs neither an unpublished Git object nor another local checkout.
The patch contains Box code under Apache-2.0; its license and attribution are
preserved in `upstream/LICENSE` and `upstream/NOTICE`. The prepared source also
retains Box's full third-party notices.

## Embed in the trusted host

Within the host's Tokio runtime, call `strands_credential_proxy::load(path)` and
pass the resulting `Arc<CredentialProxy>` to Box's protected hosted startup.
The host retains its existing capabilities, policy, telemetry, opened inspection
CA, history, and workload containment. Do not replace them with the sender.

The installation JSON contains these fields:

| Field                      | Trusted input                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `sandboxId`, `instanceId`  | Enrolled execution and unique UUIDv4 sender instance                                          |
| `audience`, `authorityUri` | OCE exchange audience and HTTPS authority endpoint                                            |
| `authorityCaPath`          | CA authenticating that endpoint                                                               |
| `exchangeSeedPath`         | Private file holding the enrolled 32-byte Ed25519 seed                                        |
| `bearerPath`               | Private file holding the issuer-signed execution JWT                                          |
| `policyHash`               | Acknowledged execution policy SHA-256, lowercase hexadecimal                                  |
| `route`                    | Exact `host`, `port`, `method`, `path`, `deadlineMs`, `connectIp`, and optional `originCaPem` |

These files belong to the trusted host and must be inaccessible to the workload.
The host must create a new enrolled instance on replacement and withdraw its old
association. OCE must already have acknowledged the exact execution, sender key,
policy, source binding, and response custody. Copying this JSON is not enrollment.
The sender checks projected identity locally; OCE authenticates the signature and
live installation on the signed stream. No provider secret is an input file:
OCE resolves it for each request and sends it only to the authenticated sender.

The only signed and forwarded request headers are `Host`, `Content-Type` and
`Accept`. Box removes transport framing first; the sender rebuilds `Host` from
the bound target. For OpenAI Node SDK 7.5.0 `responses.create`, configure the public,
nonsecret `apiKey: "oce-placeholder"`, the admitted base URL, and `maxRetries: 0`.
The sender accepts exactly one `Authorization: Bearer oce-placeholder` and
discards it before opening the OCE exchange. It is not an authentication token.
Every other Authorization value, duplicate header, cookie, provider credential
header or unknown field is refused before resolution. Never configure a real
provider key in the workload SDK.

The sender also discards these explicit SDK/Fetch informational fields:
`User-Agent`, `X-Stainless-Arch`, `X-Stainless-Lang`, `X-Stainless-OS`,
`X-Stainless-Package-Version`, `X-Stainless-Retry-Count`, `X-Stainless-Runtime`,
`X-Stainless-Runtime-Version`, `X-Stainless-Timeout`, `Accept-Encoding`,
`Accept-Language` and `Sec-Fetch-Mode`. Their values are untrusted and are neither
signed, forwarded nor persisted by the sender. This is not a wildcard allowance
for SDK headers: organization, project, beta, idempotency and arbitrary additional
fields still refuse. The body remains subject to OCE's Responses classifier.
`response_approved_for_gateway` means OCE approved the bounded response for return
to Box; Box's response policy and original writer still decide actual delivery.

Only HTTPS Responses POST is supported, with no query, redirect, retry, origin
connection reuse, or incremental response release. Request and response bodies
are limited to 1 MiB, the operation deadline to 30 seconds, and origin response
headers to 128 fields. Finite SSE is buffered and still subject to OCE's provider
response policy. Other model operations fail closed. Withdrawal before final
authorization prevents the write; a permit already issued is subject to its
checked start deadline, not instantaneous revocation.

## Run the reference transport

`target/debug/oce-reference-gateway GATEWAY.json` starts a loopback-only Box
gateway with real Box policy and this sender. The gateway JSON contains:

- `sender`: path to the trusted installation JSON above.
- `policy`: path to the Box policy; `history`: its durable history file.
- `trustDirectory`: directory for the public inspection CA.
- `listen`: loopback address and port; port zero selects an available port.
- `governedBox`: the host-owned Box identity.
- `dns`: pairs of enrolled hostnames and their pinned IP addresses.

Startup prints the selected port and public CA path. SIGINT stops the gateway.
This executable starts no Agent, provides no containment, and cannot enroll an
execution. It is useful for exercising an already enrolled transport. Never
place it in front of an uncontained workload and claim direct egress is denied.

## Verify against OCE

With the repository's Node dependencies prepared:

```sh
OCC_TEST_STRANDS_SENDER_BINARY="$PWD/runtimes/strands-credential-proxy/target/debug/oce-reference-gateway" \
  node --test tests/integration/strands-protected-sender.test.ts
```

This runs the compiled sender, Box policy, OCE controller/IAM/Secret adapters and
the signed TLS authority against a controlled TLS origin. Installation and
Kubernetes observations use the existing integration fixture. It does not prove
native Driver enrollment, ARM64 execution, or direct-egress containment.

Main does not include the native Box Driver. Protected-profile admission must
remain disabled until that supplier binds the hosted sender to its admitted
execution and authenticated Harness and passes the installed no-bypass checks.
The sender library alone cannot establish those facts.

## Optional native launcher

Build `oce-protected-box` with `cargo build --locked --manifest-path
runtimes/strands-credential-proxy/Cargo.toml --features native-launcher`. This is
an optional executable; the ordinary Box binary remains separate.

`src/launcher.rs` calls `strands_box::run` synchronously with an empty workload
argument vector. It supplies a same-process `OnceLock<Arc<CredentialProxy>>`
exchange. An empty slot returns `Unavailable`. Box invokes the fallible
`on_ready` callback after hardening, inside its runtime and before workload
setup. Only then does the launcher load the sender and set the slot once. A
missing or invalid installation, absent or mismatched bearer, or failed
initialization aborts startup. No second runtime or reference gateway is started. The separate nonsecret pin
manifest is read before `run` because Box requires its routing pins in
`RunOptions`; errors are held until the hardened callback. No networking occurs
during that read. The callback requires exactly one pin matching the enrolled
route before initializing the sender slot.

### Trusted supervisor API and mounts

Install the launcher as `/opt/strands-box/oce-protected-box`, beside the ordinary
Box binary and its matching trampoline. The executable accepts **no arguments** and has no environment override for
its input paths. The native supervisor must select it through trusted admission
instead of spawning `strands-box run --config ...`. Preserve inherited stdio,
signal supervision and `EXPERIMENTAL_LINUX_SUPPORT=TRUE` on Linux. Do not let the
workload select this executable or its installation inputs.

| Input                                                         | Contract                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/strands-box/box.toml`                                   | Existing trusted Box configuration; its agent command supplies the workload.                                                        |
| `/etc/oce-protected-sender/pins.json`                         | Nonsecret trusted JSON, exactly `[["provider.example", "192.0.2.1"]]`; the hostname and IP must equal the enrolled route.           |
| `/etc/oce-protected-sender/installation.json`                 | The installation object documented above, mounted read-only only into the trusted supervisor container.                             |
| Seed, bearer and authority CA paths named in the installation | Private, read-only supervisor mounts; use absolute paths under `/etc/oce-protected-sender/`. Never place provider credentials here. |

Do not append these private mounts to an array shared with `box-workload`, put
them in `workload.json`, or grant them through Box filesystem policy. Keep the
existing workload transport identity separate. Replacement needs a new enrolled
sender identity and withdrawal of the old association.

The launcher checks the local projection; that does **not** authenticate an
installation acknowledgment. The native Driver and ingress supplier must enroll
and acknowledge the execution, Harness, audience, sender key, policy and source
binding before choosing this binary. OCE checks live authority on each signed
request. Main still has no native Box Driver. Protected-profile admission must
remain disabled without that supplier and installed no-bypass proof.

### Local packaging and startup controls

After `prepare-box.sh`, run `bash runtimes/strands-credential-proxy/package-native.sh
/absolute/output/directory`. The package contains the optional launcher, ordinary
Box, socket alias and containment trampoline, with executable modes and input
and binary hashes. The standalone OCE lockfile controls the joined binary;
Box's unchanged lockfile controls the ordinary binary and trampoline. Every
build in this recipe uses `--locked`. Both Rust dependencies and all packaged Box executables use
the same physical `build-input/box` tree. Their separate Cargo workspaces use
separate artifact directories (`target` and `target/box`) to avoid mixing
dependency graphs. This is a local build, not an image
publication or installed qualification.

On Linux with Python, strace and bubblewrap, and with no installation mounted at the fixed
path, run:

```sh
python3 runtimes/strands-credential-proxy/checks/native-startup.py \
  runtimes/strands-credential-proxy/target/debug/oce-protected-box
```

This invokes the actual binary, proves that its missing-installation failure
comes from `on_ready` after successful memory hardening, and checks that it
attempts neither networking nor workload execution. Private mount namespaces exercise malformed and incomplete installation files
through the same callback. The binary also rejects extra arguments. A preflight or host-capability failure is a failed check, never a skip.
It does not establish the installed allowed path, valid enrolled-workload startup,
Driver mount isolation, or direct-egress containment.

The Box-owned native path is `crates/box/src/lib.rs` (`run`, `RunOptions`),
`crates/box/src/command/mod.rs` (hardening, runtime and callback ordering), and
`crates/box/src/run/hosted.rs` (policy, telemetry, opened CA and exchange). The
OCE Driver supplier remains `apps/controller/src/drivers/sandbox/strands-box.ts`
and `strands-box-resources.ts` on the separate native candidate. Join that
supplier without importing the historical all-in-one credential Driver.
